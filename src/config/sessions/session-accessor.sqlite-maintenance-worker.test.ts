import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  beginSessionWorkAdmission,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
  replaceTranscriptEventsSync,
} from "./session-accessor.js";
import { patchSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import * as maintenance from "./session-accessor.sqlite-maintenance.js";
import * as reclamationCommit from "./session-accessor.sqlite-reclamation-commit.js";
import { registerSessionMaintenancePreserveKeysProvider } from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

afterEach(() => vi.restoreAllMocks());

function observeMaintenance() {
  const finalize = maintenance.finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort;
  const completed = createDeferredCore<Awaited<ReturnType<typeof finalize>>>();
  vi.spyOn(
    maintenance,
    "finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort",
  ).mockImplementation(async (...args) => {
    try {
      const result = await finalize(...args);
      completed.resolve(result);
      return result;
    } catch (error) {
      completed.reject(error);
      throw error;
    }
  });
  return completed.promise;
}

it.each([false, true])(
  "runs automatic maintenance row planning off-thread (removal: %s)",
  async (remove) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const active = { sessionKey: "agent:main:maintenance-worker-active", storePath };
      const stale = { sessionKey: "agent:main:subagent:maintenance-worker-stale", storePath };
      replaceSessionEntrySync(active, { sessionId: "active", updatedAt: Date.now() });
      if (remove) {
        replaceSessionEntrySync(stale, { sessionId: "stale", updatedAt: 1 });
        replaceTranscriptEventsSync({ ...stale, sessionId: "stale" }, [
          { type: "session", id: "stale", content: "synthetic maintenance archive" },
        ]);
      }
      const completed = observeMaintenance();
      await patchSessionEntryCore(active, () => ({ label: "updated" }), {
        maintenanceConfig: resolveMaintenanceConfigFromInput({
          mode: "enforce",
          maxEntries: 100,
          pruneAfter: "1s",
        }),
      });
      const { DatabaseSync, StatementSync } = requireNodeSqlite();
      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
      const exec = vi.spyOn(DatabaseSync.prototype, "exec");
      const statements = (["get", "all", "run", "iterate"] as const).map((method) =>
        vi.spyOn(StatementSync.prototype, method),
      );
      const preservation = vi.fn(() => []);
      const unregister = registerSessionMaintenancePreserveKeysProvider(preservation);
      const result = await completed.finally(unregister);
      const sql = prepare.mock.calls.map(([query]) => query);
      const counts = {
        prepare: prepare.mock.calls.length,
        exec: exec.mock.calls.length,
        ...Object.fromEntries(
          statements.map((spy, index) => [
            ["get", "all", "run", "iterate"][index],
            spy.mock.calls.length,
          ]),
        ),
      };
      prepare.mockRestore();
      exec.mockRestore();
      statements.forEach((spy) => spy.mockRestore());
      console.info("automatic-maintenance parent SQL", { remove, ...counts });
      expect(sql.filter((query) => /(?:from|update|into) "session_nodes"/iu.test(query))).toEqual(
        [],
      );
      if (!remove) {
        expect(Object.values(counts).every((count) => count === 0)).toBe(true);
        expect(preservation).not.toHaveBeenCalled();
      }
      expect(loadSessionEntry(active)?.label).toBe("updated");
      if (remove) {
        expect(result.pruned).toBe(1);
        expect(loadSessionEntry(stale)).toBeUndefined();
        expect(result.archivedTranscripts).toHaveLength(1);
      }
    });
  },
);

it.each(["provider", "work-key", "work-id", "lifecycle-key", "lifecycle-id", "ancestor"] as const)(
  "preserves %s protection through automatic worker planning",
  async (protection) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const active = { sessionKey: "agent:main:maintenance-protection-active", storePath };
      const protectedKey = "agent:main:subagent:maintenance-protected";
      const protectedId = "maintenance-protected-id";
      const aliasKey = "agent:main:subagent:maintenance-protected-alias";
      const sibling = "agent:main:subagent:maintenance-unprotected";
      replaceSessionEntrySync(active, { sessionId: "active", updatedAt: Date.now() });
      replaceSessionEntrySync(
        { sessionKey: protectedKey, storePath },
        {
          sessionId: protectedId,
          updatedAt: 1,
        },
      );
      if (protection.endsWith("-id")) {
        replaceSessionEntrySync(
          { sessionKey: aliasKey, storePath },
          {
            sessionId: protectedId,
            updatedAt: 1,
          },
        );
      }
      replaceSessionEntrySync(
        { sessionKey: sibling, storePath },
        {
          sessionId: "unprotected",
          updatedAt: 1,
        },
      );
      const run = async () => {
        const completed = observeMaintenance();
        await patchSessionEntryCore(
          active,
          () => ({
            label: "protected",
            ...(protection === "ancestor" ? { parentSessionKey: protectedKey } : {}),
          }),
          {
            maintenanceConfig: resolveMaintenanceConfigFromInput({
              mode: "enforce",
              maxEntries: 100,
              pruneAfter: "1s",
            }),
          },
        );
        await completed;
        expect(loadSessionEntry({ sessionKey: protectedKey, storePath })?.sessionId).toBe(
          protectedId,
        );
        expect(loadSessionEntry({ sessionKey: sibling, storePath })).toBeUndefined();
        if (protection.endsWith("-id")) {
          expect(loadSessionEntry({ sessionKey: aliasKey, storePath })?.sessionId).toBe(
            protectedId,
          );
        }
      };
      if (protection === "provider") {
        let reverse = false;
        const unregister = registerSessionMaintenancePreserveKeysProvider(() => {
          reverse = !reverse;
          const keys = [protectedKey.toUpperCase(), active.sessionKey];
          return reverse ? keys.toReversed() : keys;
        });
        try {
          await run();
        } finally {
          unregister();
        }
      } else if (protection === "ancestor") {
        await run();
      } else {
        const identity = protection.endsWith("-key") ? protectedKey : protectedId;
        if (protection.startsWith("lifecycle")) {
          await runExclusiveSessionLifecycleMutation({
            scope: storePath,
            identities: [identity],
            run,
          });
        } else {
          const lease = await beginSessionWorkAdmission({
            scope: storePath,
            identities: [identity],
            assertAllowed: () => {},
          });
          try {
            await run();
          } finally {
            lease.release();
          }
        }
      }
    });
  },
);

it("rolls back archive metadata when protection changes at planning commit", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const active = { sessionKey: "agent:main:maintenance-live-protection", storePath };
    const protectedKey = "agent:main:maintenance-newly-protected";
    const staleKey = "agent:main:maintenance-still-stale";
    replaceSessionEntrySync(active, { sessionId: "active", updatedAt: Date.now() });
    replaceSessionEntrySync(
      { sessionKey: protectedKey, storePath },
      { sessionId: "protected", updatedAt: 1 },
    );
    replaceSessionEntrySync(
      { sessionKey: staleKey, storePath },
      { sessionId: "stale", updatedAt: 1 },
    );
    let protectedNow = false;
    const unregister = registerSessionMaintenancePreserveKeysProvider(() =>
      protectedNow ? [protectedKey] : [],
    );
    const authorize = reclamationCommit.withSqliteReclamationAuthorization;
    vi.spyOn(reclamationCommit, "withSqliteReclamationAuthorization").mockImplementation(
      (buffer, database, assertCurrent, run) =>
        authorize(buffer, database, assertCurrent, (commit) =>
          run(() => {
            protectedNow = true;
            return commit();
          }),
        ),
    );
    try {
      const completed = observeMaintenance();
      await patchSessionEntryCore(active, () => ({ label: "updated" }), {
        maintenanceConfig: resolveMaintenanceConfigFromInput({
          mode: "enforce",
          pruneAfter: "1s",
          maxEntries: 100,
        }),
      });
      await completed;
      expect(protectedNow).toBe(true);
      expect(loadSessionEntry({ sessionKey: protectedKey, storePath })?.archivedAt).toBeUndefined();
      expect(loadSessionEntry({ sessionKey: staleKey, storePath })?.archivedAt).toEqual(
        expect.any(Number),
      );
    } finally {
      unregister();
    }
  });
});
