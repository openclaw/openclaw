import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { recordAgentDatabaseAdmissions } from "../state/agent-database-admission.js";
import * as agentDeletionDiscovery from "../state/agent-deletion-discovery.js";
import { completeAgentDeletionJournalInDatabase } from "../state/agent-deletion-journal.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import * as agentWriteAdmission from "../state/openclaw-agent-write-admission.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { runPluginHostCleanup } from "./host-hook-cleanup.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRegistry } from "./registry-types.js";

describe("plugin host cleanup session stores", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-host-cleanup-noop-");
  afterEach(() => envSnapshot.restore());

  function makeStateDir() {
    const stateDir = sessionDirs.make();
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    return stateDir;
  }

  function harnessRegistration(
    pluginId: string,
    id: string,
  ): PluginRegistry["agentHarnesses"][number] {
    return {
      pluginId,
      source: "test",
      harness: {
        id,
        label: id,
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("unused test harness");
        },
      },
    };
  }

  it("leaves entries unchanged when cleanup finds no plugin-owned state", async () => {
    const stateDir = makeStateDir();
    const storePath = path.join(stateDir, "sessions.json");
    await replaceSessionEntry({ sessionKey: "agent:main:main", storePath }, {
      sessionId: "session-id",
      updatedAt: Date.now(),
    } satisfies SessionEntry);
    const before = loadSessionEntry({ sessionKey: "agent:main:main", storePath });

    const result = await runPluginHostCleanup({
      cfg: { session: { store: storePath } },
      registry: createEmptyPluginRegistry(),
      pluginId: "noop-plugin",
      reason: "disable",
    });

    expect(result).toEqual({ cleanupCount: 0, failures: [] });
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toEqual(before);
  });

  it("cleans healthy agent state without opening a refused agent store", async () => {
    const stateDir = makeStateDir();
    const storePath = path.join(stateDir, "sessions.json");
    const scope = { agentId: "main", sessionKey: "agent:main:main", storePath };
    await replaceSessionEntry(scope, {
      sessionId: "healthy",
      updatedAt: 1,
      pluginExtensions: { fixture: { active: true } },
    });
    recordAgentDatabaseAdmissions([
      {
        agentId: "cleaner",
        paths: [path.join(stateDir, "cleaner.sqlite")],
        embeddedOwnerId: "main",
        code: "agent-database-ownership-mismatch",
        reason: "Refused agent cleaner",
        repairHint: "Inspect the copy.",
      },
    ]);
    try {
      const result = await runPluginHostCleanup({
        cfg: {},
        registry: createEmptyPluginRegistry(),
        pluginId: "fixture",
        reason: "disable",
        sessionStoreTargets: [
          { agentId: "cleaner", storePath: path.join(stateDir, "cleaner.sqlite") },
          { agentId: "main", storePath },
        ],
      });
      expect(result).toEqual({ cleanupCount: 1, failures: [] });
      expect(loadSessionEntry(scope)?.pluginExtensions).toBeUndefined();
      await expect(fs.stat(path.join(stateDir, "cleaner.sqlite"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      recordAgentDatabaseAdmissions([]);
    }
  });

  it.each(["retained", "snapshot-rejected", "shared", "unfinished"] as const)(
    "preserves deleted-agent state during cleanup (%s)",
    async (mode) => {
      const stateDir = makeStateDir();
      const shared = mode === "shared";
      const completed = mode !== "unfinished";
      const scope = (agentId: string) => ({
        agentId,
        sessionKey: `agent:${agentId}:main`,
        storePath: shared
          ? path.join(stateDir, "shared", "sessions.json")
          : path.join(stateDir, "agents", agentId, "sessions", "sessions.json"),
      });
      const retired = scope("retired");
      const active = scope("main");
      const retiredDatabase = shared
        ? openOpenClawAgentDatabase({ agentId: "retired", env: process.env }).path
        : path.join(stateDir, "agents", "retired", "agent", "openclaw-agent.sqlite");
      for (const target of completed ? [active, retired] : [retired]) {
        await replaceSessionEntry(target, {
          sessionId: `${target.agentId}-${shared ? "shared" : "session"}`,
          updatedAt: 1,
          pluginExtensions: { fixture: { active: true } },
        });
      }
      await closeOpenClawAgentDatabasesAsync();
      const before = shared ? loadSessionEntry(retired) : await fs.readFile(retiredDatabase);
      const operationId = randomUUID();
      beginAgentDeletionJournal(
        {
          agentId: "retired",
          operationId,
          agentDir: path.dirname(retiredDatabase),
          sessionsDir: path.join(stateDir, "agents", "retired", "sessions"),
          workspaceDir: path.join(stateDir, "workspace-retired"),
          databasePaths: [retiredDatabase],
          deleteFiles: false,
        },
        { env: process.env },
      );
      if (completed) {
        runOpenClawStateWriteTransaction(
          (database) => completeAgentDeletionJournalInDatabase(database, "retired", operationId),
          { env: process.env },
        );
      }
      const snapshotRead =
        mode === "snapshot-rejected"
          ? vi
              .spyOn(agentDeletionDiscovery, "listRetainedDeletedAgentIdsForCleanup")
              .mockRejectedValueOnce(new Error("snapshot read rejected"))
          : undefined;
      try {
        const result = await runPluginHostCleanup({
          cfg: {
            agents: { ownership: "explicit", entries: { main: {} } },
            ...(shared ? { session: { store: active.storePath } } : {}),
          },
          registry: createEmptyPluginRegistry(),
          pluginId: "fixture",
          reason: "disable",
          sessionStoreTargets: completed ? [retired, active] : [retired],
        });
        expect(result).toEqual({
          cleanupCount: completed ? 1 : 0,
          failures:
            mode === "snapshot-rejected" || !completed
              ? [expect.objectContaining({ pluginId: "fixture", hookId: "session-store" })]
              : [],
        });
        if (completed) {
          expect(loadSessionEntry(active)?.pluginExtensions).toBeUndefined();
        }
        expect(shared ? loadSessionEntry(retired) : await fs.readFile(retiredDatabase)).toEqual(
          before,
        );
      } finally {
        snapshotRead?.mockRestore();
      }
    },
  );

  it.each(["cancelled", "already-cleared", "locked", "revoked", "committed"] as const)(
    "revalidates queued cleanup and counts only committed changes (%s)",
    async (mode) => {
      const stateDir = makeStateDir();
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:cleanup-target",
        storePath: path.join(stateDir, "agents", "main", "sessions", "sessions.json"),
      };
      await replaceSessionEntry(scope, {
        sessionId: "cleanup-target",
        updatedAt: 100,
        pluginExtensions: { fixture: { state: true }, other: { state: true } },
      });
      const before = loadSessionEntry(scope);
      const registry = createEmptyPluginRegistry();
      registry.agentHarnesses.push(harnessRegistration("fixture", "fixture-harness"));
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const blocker = patchSessionEntryCore(
        scope,
        async (entry) => {
          entered.resolve();
          await release.promise;
          if (mode === "already-cleared") {
            entry.pluginExtensions = { other: { state: true } };
            return entry;
          }
          if (mode === "locked") {
            entry.modelSelectionLocked = true;
            entry.agentHarnessId = "fixture-harness";
            return entry;
          }
          return null;
        },
        { replaceEntry: true, skipMaintenance: true },
      );
      await entered.promise;
      const queued = createDeferredCore();
      const admit = agentWriteAdmission.runOpenClawAgentWriteAdmission;
      const admission = vi
        .spyOn(agentWriteAdmission, "runOpenClawAgentWriteAdmission")
        .mockImplementation((...args) => {
          const result = admit(...args);
          queued.resolve();
          return result;
        });
      let current = true;
      const revoked = new Error("session reset authority changed");
      const cleanup = runPluginHostCleanup({
        cfg: {},
        registry,
        reason: mode === "revoked" ? "reset" : "disable",
        pluginId: "fixture",
        sessionKey: scope.sessionKey,
        sessionStoreTargets: [{ agentId: scope.agentId, storePath: scope.storePath }],
        shouldCleanup: () => {
          if (!current && mode === "revoked") {
            throw revoked;
          }
          return current;
        },
      });
      const settled = Promise.allSettled([blocker, cleanup]);
      try {
        await Promise.race([
          queued.promise,
          cleanup.then(() => {
            throw new Error("Cleanup completed before writer admission");
          }),
        ]);
        expect(
          [...agentWriteAdmission.SQLITE_SESSION_WRITER_QUEUES.values()].reduce(
            (count, queue) => count + queue.pending.length,
            0,
          ),
        ).toBe(1);
        current = mode !== "cancelled" && mode !== "revoked";
        release.resolve();
        const [blockedWrite, result] = await settled;
        expect(blockedWrite.status).toBe("fulfilled");
        expect(result).toEqual(
          mode === "revoked"
            ? { status: "rejected", reason: revoked }
            : {
                status: "fulfilled",
                value: { cleanupCount: mode === "committed" ? 1 : 0, failures: [] },
              },
        );
        const after = loadSessionEntry(scope);
        if (mode === "committed") {
          expect(after?.pluginExtensions).toEqual({ other: { state: true } });
          expect(after?.updatedAt).toBeGreaterThan(100);
        } else if (mode === "already-cleared") {
          expect(after).toEqual({ ...before, pluginExtensions: { other: { state: true } } });
        } else if (mode === "locked") {
          expect(after).toEqual({
            ...before,
            modelSelectionLocked: true,
            agentHarnessId: "fixture-harness",
          });
        } else {
          expect(after).toEqual(before);
        }
      } finally {
        admission.mockRestore();
        release.resolve();
        await settled;
      }
    },
  );

  it("can defer persistent session-state cleanup to an atomic owner", async () => {
    const stateDir = makeStateDir();
    const storePath = path.join(stateDir, "sessions.json");
    await replaceSessionEntry({ sessionKey: "agent:main:main", storePath }, {
      sessionId: "session-id",
      updatedAt: Date.now(),
      pluginExtensions: {
        test: {
          state: { active: true },
        },
      },
    } satisfies SessionEntry);

    const result = await runPluginHostCleanup({
      cfg: { session: { store: storePath } },
      registry: createEmptyPluginRegistry(),
      reason: "reset",
      sessionKey: "agent:main:main",
      skipPersistentSessionState: true,
    });

    expect(result).toEqual({ cleanupCount: 0, failures: [] });
    expect(
      loadSessionEntry({ sessionKey: "agent:main:main", storePath })?.pluginExtensions,
    ).toEqual({
      test: {
        state: { active: true },
      },
    });
  });

  it.each([
    [
      "Matrix group",
      "agent:main:matrix:group:!Room:server",
      "agent:main:matrix:group:!room:server",
      "AGENT:MAIN:MATRIX:GROUP:!Room:server",
    ],
    [
      "Matrix channel",
      "agent:main:matrix:channel:!Room:server",
      "agent:main:matrix:channel:!room:server",
      "agent:main:matrix:channel:!Room:server",
    ],
    [
      "Matrix thread",
      "agent:main:matrix:group:!Room:server:thread:$Event",
      "agent:main:matrix:group:!Room:server:thread:$event",
      "agent:main:matrix:group:!Room:server:THREAD:$Event",
    ],
    [
      "Signal group",
      "agent:main:signal:group:AbCdEf==",
      "agent:main:signal:group:abcdef==",
      "AGENT:MAIN:SIGNAL:GROUP:AbCdEf==",
    ],
  ])(
    "clears only the selected %s session's plugin state",
    async (_, targetKey, siblingKey, filter) => {
      const stateDir = makeStateDir();
      const storePath = path.join(stateDir, "sessions.json");
      for (const [sessionKey, sessionId] of [
        [targetKey, "target"],
        [siblingKey, "sibling"],
      ] as const) {
        await replaceSessionEntry({ sessionKey, storePath }, {
          sessionId,
          updatedAt: Date.now(),
          pluginExtensions: {
            cleanup: { state: { sessionId } },
            other: { state: { preserved: true } },
          },
          pluginNextTurnInjections: {
            cleanup: [
              {
                id: sessionId,
                pluginId: "cleanup",
                text: sessionId,
                placement: "append_context",
                createdAt: Date.now(),
              },
            ],
          },
        } satisfies SessionEntry);
      }
      const siblingBefore = loadSessionEntry({ sessionKey: siblingKey, storePath });
      expect(siblingBefore?.sessionId).toBe("sibling");

      const result = await runPluginHostCleanup({
        cfg: { session: { store: storePath } },
        registry: createEmptyPluginRegistry(),
        pluginId: "cleanup",
        reason: "delete",
        sessionKey: filter,
      });

      expect(result).toEqual({ cleanupCount: 1, failures: [] });
      await closeOpenClawAgentDatabasesAsync();
      const target = loadSessionEntry({ sessionKey: targetKey, storePath });
      expect(target?.pluginExtensions).toEqual({ other: { state: { preserved: true } } });
      expect(target?.pluginNextTurnInjections).toBeUndefined();
      expect(loadSessionEntry({ sessionKey: siblingKey, storePath })).toEqual(siblingBefore);
    },
  );

  it("matches a key-like runtime session ID case-insensitively without interpreting it as a key", async () => {
    const runtimeSessionId = "signal:group: Opaque";
    const stateDir = makeStateDir();
    const firstStorePath = path.join(stateDir, "agents", "a", "sessions", "sessions.json");
    const secondStorePath = path.join(stateDir, "agents", "b", "sessions", "sessions.json");
    const beforeUpdatedAt = 100;
    const unrelatedUpdatedAt = Date.now();
    const firstEntry: SessionEntry = {
      sessionId: runtimeSessionId,
      updatedAt: beforeUpdatedAt,
      pluginExtensions: {
        cleanup: { state: { active: true } },
        other: { state: { preserved: true } },
      },
      pluginNextTurnInjections: {
        cleanup: [
          {
            id: "remove",
            pluginId: "cleanup",
            text: "remove",
            placement: "append_context",
            createdAt: beforeUpdatedAt,
          },
        ],
      },
    };
    const secondEntry: SessionEntry = {
      sessionId: runtimeSessionId,
      updatedAt: beforeUpdatedAt,
      pluginExtensions: {
        cleanup: { state: { active: true } },
      },
    };
    const unrelatedEntry: SessionEntry = {
      sessionId: "unrelated-session",
      updatedAt: unrelatedUpdatedAt,
      delivery: { kind: "none" },
      pluginExtensions: {
        cleanup: { state: { keep: true } },
      },
    };
    await replaceSessionEntry(
      { sessionKey: "agent:a:telegram:group:shared-room", storePath: firstStorePath },
      firstEntry,
    );
    await replaceSessionEntry(
      { sessionKey: "agent:a:telegram:group:unrelated-room", storePath: firstStorePath },
      unrelatedEntry,
    );
    await replaceSessionEntry(
      { sessionKey: "agent:b:telegram:group:shared-room", storePath: secondStorePath },
      secondEntry,
    );

    const result = await runPluginHostCleanup({
      cfg: { session: { store: firstStorePath } },
      registry: createEmptyPluginRegistry(),
      pluginId: "cleanup",
      reason: "disable",
      sessionKey: runtimeSessionId.toUpperCase(),
      sessionStoreTargets: [
        { agentId: "a", storePath: firstStorePath },
        { agentId: "b", storePath: secondStorePath },
      ],
    });

    expect(result).toEqual({ cleanupCount: 2, failures: [] });
    const firstMain = loadSessionEntry({
      sessionKey: "agent:a:telegram:group:shared-room",
      storePath: firstStorePath,
    });
    const firstUnrelated = loadSessionEntry({
      sessionKey: "agent:a:telegram:group:unrelated-room",
      storePath: firstStorePath,
    });
    const secondOther = loadSessionEntry({
      sessionKey: "agent:b:telegram:group:shared-room",
      storePath: secondStorePath,
    });
    expect(firstMain?.pluginExtensions).toEqual({
      other: { state: { preserved: true } },
    });
    expect(firstMain?.pluginNextTurnInjections).toBeUndefined();
    expect(firstMain?.updatedAt).toBeGreaterThan(beforeUpdatedAt);
    expect(firstUnrelated).toEqual(unrelatedEntry);
    expect(secondOther?.pluginExtensions).toBeUndefined();
    expect(secondOther?.updatedAt).toBeGreaterThan(beforeUpdatedAt);
  });

  it("clears shared custom SQLite stores for each resolved agent", async () => {
    const stateDir = makeStateDir();
    const sharedStorePath = path.join(stateDir, "custom", "sessions.json");
    const beforeUpdatedAt = 100;
    const entry: SessionEntry = {
      sessionId: "shared-session",
      updatedAt: beforeUpdatedAt,
      pluginExtensions: {
        cleanup: { state: { active: true } },
      },
    };
    await replaceSessionEntry(
      { agentId: "main", sessionKey: "agent:main:main", storePath: sharedStorePath },
      entry,
    );
    await replaceSessionEntry(
      { agentId: "work", sessionKey: "agent:work:main", storePath: sharedStorePath },
      entry,
    );

    const result = await runPluginHostCleanup({
      cfg: {
        session: { store: sharedStorePath },
        agents: {
          entries: { main: {}, work: {} },
          defaults: { sessionStore: { agentId: "main" } },
        },
      },
      registry: createEmptyPluginRegistry(),
      pluginId: "cleanup",
      reason: "disable",
    });

    expect(result).toEqual({ cleanupCount: 2, failures: [] });
    const main = loadSessionEntry({
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath: sharedStorePath,
    });
    const work = loadSessionEntry({
      agentId: "work",
      sessionKey: "agent:work:main",
      storePath: sharedStorePath,
    });
    expect(main?.pluginExtensions).toBeUndefined();
    expect(main?.updatedAt).toBeGreaterThan(beforeUpdatedAt);
    expect(work?.pluginExtensions).toBeUndefined();
    expect(work?.updatedAt).toBeGreaterThan(beforeUpdatedAt);
  });

  it("preserves locked sessions for every harness owned by a disabled plugin", async () => {
    const stateDir = makeStateDir();
    const storePath = path.join(stateDir, "sessions.json");
    const updatedAt = 100;
    const registry = createEmptyPluginRegistry();
    registry.agentHarnesses.push(
      ...["fixture-harness-a", "fixture-harness-b"].map((id) =>
        harnessRegistration("fixture-plugin", id),
      ),
      harnessRegistration("other-plugin", "other-harness"),
    );
    for (const suffix of ["a", "b"]) {
      await replaceSessionEntry({ storePath, sessionKey: `agent:main:harness-${suffix}:locked` }, {
        sessionId: `locked-session-${suffix}`,
        updatedAt,
        agentHarnessId: `fixture-harness-${suffix}`,
        modelSelectionLocked: true,
        pluginExtensions: {
          "fixture-plugin": {
            supervision: { sourceThreadId: `native-thread-${suffix}`, modelLocked: true },
          },
        },
      } satisfies SessionEntry);
    }
    for (const [sessionKey, sessionId, agentHarnessId] of [
      ["agent:main:other-harness:locked", "other-locked-session", "other-harness"],
      ["agent:main:ordinary", "ordinary-session", undefined],
    ] as const) {
      await replaceSessionEntry({ storePath, sessionKey }, {
        sessionId,
        updatedAt,
        ...(agentHarnessId ? { agentHarnessId, modelSelectionLocked: true } : {}),
        pluginExtensions: { "fixture-plugin": { transient: true } },
      } satisfies SessionEntry);
    }

    const result = await runPluginHostCleanup({
      cfg: { session: { store: storePath } },
      registry,
      pluginId: "fixture-plugin",
      reason: "disable",
      sessionStoreTargets: [{ agentId: "main", storePath }],
    });

    expect(result).toEqual({ cleanupCount: 2, failures: [] });
    const readEntry = (sessionKey: string) => loadSessionEntry({ storePath, sessionKey });
    for (const suffix of ["a", "b"]) {
      expect(readEntry(`agent:main:harness-${suffix}:locked`)).toMatchObject({
        updatedAt,
        agentHarnessId: `fixture-harness-${suffix}`,
        modelSelectionLocked: true,
        pluginExtensions: {
          "fixture-plugin": {
            supervision: { sourceThreadId: `native-thread-${suffix}`, modelLocked: true },
          },
        },
      });
    }
    expect(readEntry("agent:main:other-harness:locked")?.pluginExtensions).toBeUndefined();
    expect(readEntry("agent:main:ordinary")?.pluginExtensions).toBeUndefined();
  });
});
