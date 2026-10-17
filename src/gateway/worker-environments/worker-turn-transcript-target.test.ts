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
  resolveWorkerTurnTranscriptTarget,
  captureWorkerTurnTranscriptSource,
  prepareWorkerTurnTranscriptSource,
  withWorkerTurnTranscriptDatabase,
} from "./worker-turn-transcript-target.js";

afterEach(() => {
  memorySessionActorOwners.reset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const staleTranscript = "transcript identity is no longer current";
const turnFor = (target: BoundAgentRunSessionTarget) => ({ ...target, sessionTarget: target });
const currentAuthority = () => ({ isCurrent: () => true, release() {} });

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
  write: () => Promise<void>,
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
      expect(
        (
          await actor.storage!.mutate(
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
          )
        ).kind,
      ).toBe("committed");
      const observer = observeHostDataSql();
      try {
        const source = captureWorkerTurnTranscriptSource(target);
        const run = vi.fn(async () => {
          source();
          expect(resolveWorkerTurnTranscriptTarget(turnFor(target))).toEqual(target);
          return "settled";
        });
        const result = withWorkerTurnTranscriptDatabase(
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
        observer.restore();
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
      let active = true;
      const assertCurrent = () => {
        if (!active) {
          throw new Error("Cloud turn ended");
        }
      };
      const releaseAuthority = vi.fn();
      const controls = {
        assertCurrent,
        prepareAuthority: async () => ({ isCurrent: () => active, release: releaseAuthority }),
      };
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const inspections: string[] = [];
      const observer = observeHostDataSql((sql, observedDatabase) => {
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
      try {
        const result = await withWorkerTurnTranscriptDatabase(turn, controls, async (pinned) => {
          expect(resolveWorkerTurnTranscriptTarget({ ...turn, sessionTarget: pinned })).toEqual(
            target,
          );
          const held = agentDatabase.getOpenClawAgentDatabaseIfOpen(options);
          expect(held?.db.isOpen).toBe(true);
          await vi.advanceTimersByTimeAsync(SQLITE_IDLE_HANDLE_TTL_MS);
          expect(agentDatabase.getOpenClawAgentDatabaseIfOpen(options)).toBe(held);
          expect(
            resolveWorkerTurnTranscriptTarget({ ...turn, sessionTarget: pinned }).sessionId,
          ).toBe(target.sessionId);
          nativeClaim.assertCurrent();
          active = false;
          return "settled";
        });
        expect(result).toBe("settled");
        expect(releaseAuthority).toHaveBeenCalledOnce();
        expect(inspections).toEqual([]);
        expect(observer.queries.filter(isSessionEntryDataSql)).toEqual([]);
      } finally {
        observer.restore();
        vi.useRealTimers();
      }
    } finally {
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
    const observer = observeHostDataSql();
    const incomingRpc = new AsyncResource("worker-transcript-rpc");
    const withPendingReplacement = (check: () => void, write: () => Promise<void>) =>
      duringPublication("kind", "session-entry-patch-committed", check, write);
    try {
      {
        await using rollbackSource = await prepareWorkerTurnTranscriptSource(target);
        const rollback = new Error("Roll back worker replacement");
        await withPendingReplacement(
          () => {
            expect(rollbackSource).toThrow(staleTranscript);
            throw rollback;
          },
          async () => {
            await expect(
              patchSessionEntryCore(target, () => ({ activeWriterRunId: "rolled-back-writer" })),
            ).rejects.toThrow(rollback);
          },
        );
        expect(rollbackSource).not.toThrow();
      }
      await using source = await prepareWorkerTurnTranscriptSource(target);
      source();
      await withPendingReplacement(source, async () => {
        await patchSessionEntryCore(target, () => ({ label: "same writer" }), {
          workerGuard: { source },
        });
      });
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
      await withWorkerTurnTranscriptDatabase(
        turnFor(target),
        {
          assertCurrent() {},
          prepareAuthority: async () => currentAuthority(),
        },
        async (pinned) => {
          const assertReceipt = captureWorkerTurnTranscriptSource(pinned);
          const settlementTarget = { ...pinned, expectedWriterRunId: undefined };
          const resolveSettlement = () =>
            resolveWorkerTurnTranscriptTarget(turnFor(settlementTarget));
          incomingRpc.runInAsyncScope(assertReceipt);
          const effect = vi.fn(() => {
            resolveWorkerTurnTranscriptTarget(turnFor(pinned));
          });
          effect();
          await withPendingReplacement(
            () => {
              expect(source).toThrow(staleTranscript);
              expect(effect).toThrow(staleTranscript);
            },
            async () => {
              await patchSessionEntryCore(target, () => ({ activeWriterRunId: "next-writer" }));
            },
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
      observer.restore();
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
    let active = true;
    const current = () => {
      if (!active) {
        throw new Error("Cloud run revoked");
      }
    };
    const admit = agentDatabase.withOpenClawAgentDatabaseRuntime;
    const interception = vi
      .spyOn(agentDatabase, "withOpenClawAgentDatabaseRuntime")
      .mockImplementationOnce(async (...args) => {
        active = false;
        return admit(...args);
      });
    const execute = vi.fn(async () => "executed");
    try {
      await expect(
        withWorkerTurnTranscriptDatabase(
          turn,
          {
            assertCurrent: current,
            prepareAuthority: async () => ({ isCurrent: () => active, release: () => {} }),
          },
          execute,
        ),
      ).rejects.toThrow(/placement authority changed during preparation/);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      interception.mockRestore();
    }
  });
});
