import { AsyncResource } from "node:async_hooks";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { appendAbortedSessionTranscriptPartial } from "../../config/sessions/session-accessor.sqlite-transcript-reports.js";
import { withIncognitoSessionActor } from "../../config/sessions/session-incognito-binding.js";
import { recordSessionParticipantInWorker } from "../../config/sessions/session-sharing-store.async.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../../infra/sqlite-handle-lifecycle.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { closeCachedOpenClawAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import * as agentDatabase from "../../state/openclaw-agent-db.js";
import { openIncognitoTestActor } from "../../state/openclaw-agent-execution-incognito.test-support.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  resolveWorkerTurnTranscriptTarget,
  captureWorkerTurnTranscriptSource,
  prepareWorkerTurnTranscriptSource,
  withWorkerTurnTranscriptDatabase,
} from "./worker-turn-transcript-target.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each([false, true])(
  "uses the selected actor for worker admission and refuses a changed window (%s)",
  async (replaceWindow) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const actor = await openIncognitoTestActor(state.env, { assertCurrent() {} });
      const target = {
        agentId: "main",
        sessionKey: "agent:main:dashboard:incognito-worker-target",
        sessionId: "worker-target",
        storePath: actor.path,
        expectedLifecycleRevision: "original",
      };
      await actor.sessions.create(
        { assertCurrent() {} },
        {
          sessionKey: target.sessionKey,
          entry: {
            sessionId: target.sessionId,
            updatedAt: Date.now(),
            lifecycleRevision: "original",
            incognito: true,
          },
        },
      );
      const observer = observeHostDataSql();
      try {
        await withIncognitoSessionActor(actor, async () => {
          const source = captureWorkerTurnTranscriptSource(target);
          const run = vi.fn(async () => {
            source();
            expect(resolveWorkerTurnTranscriptTarget({ ...target, sessionTarget: target })).toEqual(
              target,
            );
            return "settled";
          });
          const result = withWorkerTurnTranscriptDatabase(
            { ...target, sessionTarget: target },
            {
              assertCurrent() {},
              prepareAuthority: async () => {
                if (replaceWindow) {
                  await patchSessionEntryCore(target, () => ({ lifecycleRevision: "replacement" }));
                }
                return { isCurrent: () => true, release() {} };
              },
            },
            run,
          );
          if (replaceWindow) {
            await expect(result).rejects.toThrow("transcript identity is no longer current");
            expect(run).not.toHaveBeenCalled();
            expect(source).toThrow("generation is no longer current");
          } else {
            await expect(result).resolves.toBe("settled");
            expect(run).toHaveBeenCalledOnce();
          }
        });
        expect(observer.queries).toEqual([]);
      } finally {
        observer.restore();
        await actor.close();
      }
    });
  },
);

it("preadmits cloud transcript guards and retains their handle through turn settlement", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const options = { agentId: "main", env: state.env };
    const storePath = agentDatabase.resolveOpenClawAgentSqlitePath(options);
    const target = {
      agentId: "main",
      sessionKey: "agent:main:cloud-admission",
      sessionId: "cloud-admission",
      storePath,
      expectedLifecycleRevision: "cloud-lifecycle",
    };
    const execution = captureOpenClawAgentDatabaseExecution(options);
    try {
      await upsertSessionEntryCore(target, {
        sessionId: target.sessionId,
        lifecycleRevision: target.expectedLifecycleRevision,
        updatedAt: 1,
      });
      const database = agentDatabase.openOpenClawAgentDatabase(options);
      database.db.exec("CREATE TABLE cloud_admission_fixture(value TEXT)");
      closeCachedOpenClawAgentDatabase(database, { eviction: true });
      const nativeClaim = execution.captureGenerationClaim();
      const turn = { ...target, sessionTarget: { ...target } };
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
      agentId: "main",
      sessionKey: "agent:main:writer-receipt",
      sessionId: "writer-receipt",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
      expectedLifecycleRevision: "writer-lifecycle",
      expectedWriterRunId: "first-writer",
    };
    await upsertSessionEntryCore(target, {
      sessionId: target.sessionId,
      lifecycleRevision: target.expectedLifecycleRevision,
      activeWriterRunId: target.expectedWriterRunId,
      updatedAt: 1,
    });
    const observer = observeHostDataSql();
    const incomingRpc = new AsyncResource("worker-transcript-rpc");
    const withPendingReplacement = async (
      assertPending: () => void,
      write: () => Promise<void>,
    ) => {
      let checked = false;
      const admission = probe.admission(workerAdmission, (request, grant, admit) => {
        if (
          request.stage !== "commit" ||
          !isRecord(request.facts) ||
          !isRecord(request.facts.publication) ||
          request.facts.publication.kind !== "session-entry-patch-committed"
        ) {
          admit(request, grant);
          return;
        }
        admit(request, (beforeRelease) =>
          grant(() => {
            beforeRelease?.();
            checked = true;
            assertPending();
          }),
        );
      });
      try {
        await write();
      } finally {
        admission.mockRestore();
      }
      expect(checked).toBe(true);
    };
    try {
      {
        await using rollbackSource = await prepareWorkerTurnTranscriptSource(target);
        const rollback = new Error("Roll back worker replacement");
        await withPendingReplacement(
          () => {
            expect(rollbackSource).toThrow("transcript identity is no longer current");
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
      let checkedPendingParticipant = false;
      const admission = probe.admission(workerAdmission, (request, grant, admit) => {
        if (
          request.stage !== "commit" ||
          !isRecord(request.facts) ||
          !isRecord(request.facts.publication) ||
          request.facts.publication.type !== "participant"
        ) {
          admit(request, grant);
          return;
        }
        admit(request, (beforeRelease) =>
          grant(() => {
            beforeRelease?.();
            source();
            checkedPendingParticipant = true;
          }),
        );
      });
      try {
        expect(
          await recordSessionParticipantInWorker(target, {
            identity: { type: "agent", id: "other" },
            promptedAt: 1,
          }),
        ).toBe("inserted");
      } finally {
        admission.mockRestore();
      }
      expect(checkedPendingParticipant).toBe(true);
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
        { ...target, sessionTarget: target },
        {
          assertCurrent() {},
          prepareAuthority: async () => ({ isCurrent: () => true, release() {} }),
        },
        async (pinned) => {
          const assertReceipt = captureWorkerTurnTranscriptSource(pinned);
          const settlementTarget = { ...pinned, expectedWriterRunId: undefined };
          const resolveSettlement = () =>
            resolveWorkerTurnTranscriptTarget({
              ...settlementTarget,
              sessionTarget: settlementTarget,
            });
          incomingRpc.runInAsyncScope(assertReceipt);
          const effect = vi.fn(() => {
            resolveWorkerTurnTranscriptTarget({ ...pinned, sessionTarget: pinned });
          });
          effect();
          await withPendingReplacement(
            () => {
              expect(source).toThrow("transcript identity is no longer current");
              expect(effect).toThrow("transcript identity is no longer current");
            },
            async () => {
              await patchSessionEntryCore(target, () => ({ activeWriterRunId: "next-writer" }));
            },
          );
          expect(effect).toThrow("transcript identity is no longer current");
          expect(source).toThrow("transcript identity is no longer current");
          expect(() => incomingRpc.runInAsyncScope(assertReceipt)).toThrow(
            "transcript identity is no longer current",
          );
          expect(resolveSettlement()).toEqual(settlementTarget);
          await patchSessionEntryCore(target, () => ({ activeWriterRunId: undefined }));
          expect(resolveSettlement()).toEqual(settlementTarget);
          await patchSessionEntryCore(target, () => ({ lifecycleRevision: "next-lifecycle" }));
          expect(resolveSettlement).toThrow("transcript identity is no longer current");
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

it.each(["retarget", "revoke"] as const)(
  "refuses cloud execution when preparation is invalidated by %s",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const target = {
        agentId: "main",
        sessionKey: "agent:main:cloud-revocation",
        sessionId: "cloud-revocation",
        storePath: agentDatabase.resolveOpenClawAgentSqlitePath({
          agentId: "main",
          env: state.env,
        }),
      };
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      const turn = { ...target, sessionTarget: { ...target } };
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
          if (change === "retarget") {
            turn.sessionTarget.storePath = state.statePath("another.sqlite");
          } else {
            active = false;
          }
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
        ).rejects.toThrow(
          change === "retarget"
            ? /target changed during preparation/
            : /placement authority changed during preparation/,
        );
        expect(execute).not.toHaveBeenCalled();
      } finally {
        interception.mockRestore();
      }
    });
  },
);
