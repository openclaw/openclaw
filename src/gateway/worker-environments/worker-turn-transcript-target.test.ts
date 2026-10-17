import { AsyncResource } from "node:async_hooks";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import type { BoundAgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { appendAbortedSessionTranscriptPartial } from "../../config/sessions/session-accessor.sqlite-transcript-reports.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { recordSessionParticipantInWorker } from "../../config/sessions/session-sharing-store.async.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../../infra/sqlite-handle-lifecycle.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { closeCachedOpenClawAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import * as agentDatabase from "../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  captureWorkerTurnTranscriptSource as captureSource,
  prepareWorkerTurnTranscriptSource as prepareSource,
  resolveWorkerTurnTranscriptTarget as resolveTarget,
  withWorkerTurnTranscriptDatabase as withTranscript,
} from "./worker-turn-transcript-target.js";

afterEach(() => {
  memorySessionActorOwners.reset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const staleTranscript = "transcript identity is no longer current";
const turnFor = (target: BoundAgentRunSessionTarget) => ({ ...target, sessionTarget: target });
const currentAuthority = () => ({ isCurrent: () => true, release() {} });
function observeSql(...args: Parameters<typeof observeHostDataSql>) {
  const observer = observeHostDataSql(...args);
  return { ...observer, [Symbol.dispose]: observer.restore };
}
function placementAuthority(message: string) {
  let active = true;
  const release = vi.fn();
  return {
    revoke: () => {
      active = false;
    },
    release,
    controls: {
      assertCurrent() {
        if (!active) {
          throw new Error(message);
        }
      },
      prepareAuthority: async () => ({ isCurrent: () => active, release }),
    },
  };
}

function transcriptTarget(storePath: string, sessionId: string, lifecycle?: string) {
  return {
    agentId: "main",
    sessionKey: `agent:main:${sessionId}`,
    sessionId,
    storePath,
    expectedLifecycleRevision: lifecycle,
  };
}

async function seedTranscript(target: BoundAgentRunSessionTarget) {
  await upsertSessionEntryCore(target, {
    sessionId: target.sessionId,
    lifecycleRevision: target.expectedLifecycleRevision,
    activeWriterRunId: target.expectedWriterRunId,
    updatedAt: 1,
  });
}

async function duringPublication(
  field: "kind" | "type",
  value: string,
  check: () => void,
  write: () => Promise<unknown>,
) {
  let checked = false;
  const admission = probe.admission(workerAdmission, (request, grant, admit) => {
    if (
      request.stage !== "commit" ||
      !isRecord(request.facts) ||
      !isRecord(request.facts.publication) ||
      request.facts.publication[field] !== value
    ) {
      admit(request, grant);
      return;
    }
    admit(request, (beforeRelease) =>
      grant(() => {
        beforeRelease?.();
        checked = true;
        check();
      }),
    );
  });
  try {
    await write();
  } finally {
    admission.mockRestore();
  }
  expect(checked).toBe(true);
}

it.each([false, true])(
  "uses the selected actor for worker admission and refuses a changed window (%s)",
  async (replaceWindow) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const owner = memorySessionActorOwners.get({
        agentId: "main",
        path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
      });
      const target = {
        ...transcriptTarget(owner.path, "worker-target", "original"),
        sessionKey: "agent:main:dashboard:incognito-worker-target",
      };
      const actor = await owner.acquire(
        { database: owner.identity, sessionKey: target.sessionKey },
        { assertCurrent() {}, assertReadable() {} },
      );
      const created = await actor.storage!.mutate(
        {
          type: "session.entry.create",
          input: {
            entry: {
              sessionId: target.sessionId,
              updatedAt: Date.now(),
              lifecycleRevision: "original",
              incognito: true,
            },
          },
        },
        { assertCurrent() {}, authorize() {} },
      );
      expect(created.kind).toBe("committed");
      try {
        using observer = observeSql();
        const source = captureSource(target);
        const run = vi.fn(async () => {
          source();
          expect(resolveTarget(turnFor(target))).toEqual(target);
          return "settled";
        });
        const result = withTranscript(
          turnFor(target),
          {
            assertCurrent() {},
            prepareAuthority: async () => {
              if (replaceWindow) {
                await patchSessionEntryCore(target, () => ({ lifecycleRevision: "replacement" }));
              }
              return currentAuthority();
            },
          },
          run,
        );
        if (replaceWindow) {
          await expect(result).rejects.toThrow(staleTranscript);
          expect(run).not.toHaveBeenCalled();
          expect(source).toThrow(staleTranscript);
        } else {
          await expect(result).resolves.toBe("settled");
          expect(run).toHaveBeenCalledOnce();
        }
        expect(observer.queries).toEqual([]);
      } finally {
        await actor.release();
      }
    });
  },
);

it("preadmits cloud transcript guards and retains their handle through turn settlement", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const options = { agentId: "main", env: state.env };
    const storePath = agentDatabase.resolveOpenClawAgentSqlitePath(options);
    const target = transcriptTarget(storePath, "cloud-admission", "cloud-lifecycle");
    const execution = captureOpenClawAgentDatabaseExecution(options);
    try {
      await seedTranscript(target);
      const database = agentDatabase.openOpenClawAgentDatabase(options);
      database.db.exec("CREATE TABLE cloud_admission_fixture(value TEXT)");
      closeCachedOpenClawAgentDatabase(database);
      const nativeClaim = execution.captureGenerationClaim();
      const turn = turnFor(target);
      const authority = placementAuthority("Cloud turn ended");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const inspections: string[] = [];
      using observer = observeSql((sql, observedDatabase) => {
        if (!observedDatabase) {
          return;
        }
        const location = observedDatabase.location();
        if (
          (location === database.path || location === null) &&
          /sqlite_(?:schema|master)|PRAGMA\s+(?:index_|table_|quick_check|integrity_check|foreign_key_check)/i.test(
            sql,
          )
        ) {
          inspections.push(sql);
        }
      });
      const result = await withTranscript(turn, authority.controls, async (pinned) => {
        expect(resolveTarget({ ...turn, sessionTarget: pinned })).toEqual(target);
        const held = agentDatabase.getOpenClawAgentDatabaseIfOpen(options);
        expect(held?.db.isOpen).toBe(true);
        await vi.advanceTimersByTimeAsync(SQLITE_IDLE_HANDLE_TTL_MS);
        expect(agentDatabase.getOpenClawAgentDatabaseIfOpen(options)).toBe(held);
        expect(resolveTarget({ ...turn, sessionTarget: pinned }).sessionId).toBe(target.sessionId);
        nativeClaim.assertCurrent();
        authority.revoke();
        return "settled";
      });
      expect(result).toBe("settled");
      expect(authority.release).toHaveBeenCalledOnce();
      expect([inspections, observer.queries.filter(isSessionEntryDataSql)]).toEqual([[], []]);
    } finally {
      vi.useRealTimers();
      await execution.release();
    }
  });
});

it("retains a logical-store worker transcript and refuses writer changes without host SQL", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const target = {
      ...transcriptTarget(
        path.join(state.sessionsDir(), "sessions.json"),
        "writer-receipt",
        "writer-lifecycle",
      ),
      expectedWriterRunId: "first-writer",
    };
    await seedTranscript(target);
    using observer = observeSql();
    const incomingRpc = new AsyncResource("worker-transcript-rpc");
    const withPendingReplacement = (check: () => void, write: () => Promise<unknown>) =>
      duringPublication("kind", "session-entry-patch-committed", check, write);
    try {
      {
        await using rollbackSource = await prepareSource(target);
        const rollback = new Error("Roll back worker replacement");
        await withPendingReplacement(
          () => {
            expect(rollbackSource).toThrow(staleTranscript);
            throw rollback;
          },
          () =>
            expect(
              patchSessionEntryCore(target, () => ({ activeWriterRunId: "rolled-back-writer" })),
            ).rejects.toThrow(rollback),
        );
        expect(rollbackSource).not.toThrow();
      }
      await using source = await prepareSource(target);
      source();
      await withPendingReplacement(source, () =>
        patchSessionEntryCore(target, () => ({ label: "same writer" }), {
          workerGuard: { source },
        }),
      );
      source();
      await duringPublication("type", "participant", source, async () => {
        expect(
          await recordSessionParticipantInWorker(target, {
            identity: { type: "agent", id: "other" },
            promptedAt: 1,
          }),
        ).toBe("inserted");
      });
      source();
      await expect(
        appendAbortedSessionTranscriptPartial(target, {
          runId: target.expectedWriterRunId,
          expectedLifecycleRevision: target.expectedLifecycleRevision,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Interrupted worker response" }],
            stopReason: "aborted",
            timestamp: 2,
          },
        }),
      ).resolves.toMatchObject({ ok: true, value: { skipped: false, append: { appended: true } } });
      source();
      await withTranscript(
        turnFor(target),
        {
          assertCurrent() {},
          prepareAuthority: async () => currentAuthority(),
        },
        async (pinned) => {
          const assertReceipt = captureSource(pinned);
          const settlementTarget = { ...pinned, expectedWriterRunId: undefined };
          const resolveSettlement = () => resolveTarget(turnFor(settlementTarget));
          incomingRpc.runInAsyncScope(assertReceipt);
          const effect = () => resolveTarget(turnFor(pinned));
          effect();
          await withPendingReplacement(
            () => {
              expect(source).toThrow(staleTranscript);
              expect(effect).toThrow(staleTranscript);
            },
            () => patchSessionEntryCore(target, () => ({ activeWriterRunId: "next-writer" })),
          );
          expect(effect).toThrow(staleTranscript);
          expect(source).toThrow(staleTranscript);
          expect(() => incomingRpc.runInAsyncScope(assertReceipt)).toThrow(staleTranscript);
          expect(resolveSettlement()).toEqual(settlementTarget);
          await patchSessionEntryCore(target, () => ({ activeWriterRunId: undefined }));
          expect(resolveSettlement()).toEqual(settlementTarget);
          await patchSessionEntryCore(target, () => ({ lifecycleRevision: "next-lifecycle" }));
          expect(resolveSettlement).toThrow(staleTranscript);
        },
      );
      await source.release();
      expect(source).toThrow("Cloud worker transcript authority has been released");
      expect(observer.queries.filter(isSessionEntryDataSql)).toEqual([]);
    } finally {
      incomingRpc.emitDestroy();
    }
  });
});

it("refuses cloud execution when placement authority is revoked during preparation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const target = transcriptTarget(
      agentDatabase.resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
      "cloud-revocation",
    );
    await seedTranscript(target);
    const turn = turnFor(target);
    const authority = placementAuthority("Cloud run revoked");
    const admit = agentDatabase.withOpenClawAgentDatabaseRuntime;
    vi.spyOn(agentDatabase, "withOpenClawAgentDatabaseRuntime").mockImplementationOnce(
      async (...args) => {
        authority.revoke();
        return admit(...args);
      },
    );
    const execute = vi.fn(async () => "executed");
    await expect(withTranscript(turn, authority.controls, execute)).rejects.toThrow(
      /placement authority changed during preparation/,
    );
    expect(execute).not.toHaveBeenCalled();
  });
});
