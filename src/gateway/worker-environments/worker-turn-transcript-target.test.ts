import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../../infra/sqlite-handle-lifecycle.js";
import { closeCachedOpenClawAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import * as agentDatabase from "../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  resolveWorkerTurnTranscriptTarget,
  captureWorkerTurnTranscriptSource,
  withWorkerTurnTranscriptDatabase,
} from "./worker-turn-transcript-target.js";

afterEach(() => {
  memorySessionActorOwners.reset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each([false, true])(
  "uses the selected actor for worker admission and refuses a changed window (%s)",
  async (replaceWindow) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const owner = memorySessionActorOwners.get({
        agentId: "main",
        path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
      });
      const target = {
        agentId: "main",
        sessionKey: "agent:main:dashboard:incognito-worker-target",
        sessionId: "worker-target",
        storePath: owner.path,
        expectedLifecycleRevision: "original",
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
          expect(source).toThrow("transcript identity is no longer current");
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
      } finally {
        observer.restore();
        vi.useRealTimers();
      }
    } finally {
      await execution.release();
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
