import { randomUUID } from "node:crypto";
// Verifies host hook cleanup behavior for session-store state.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { recordAgentDatabaseAdmissions } from "../state/agent-database-admission.js";
import * as agentDeletionDiscovery from "../state/agent-deletion-discovery.js";
import {
  beginAgentDeletionJournal,
  completeAgentDeletionJournalInDatabase,
} from "../state/agent-deletion-journal.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../state/openclaw-agent-write-admission.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { runPluginHostCleanup } from "./host-hook-cleanup.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

describe("plugin host cleanup session stores", () => {
  let stateDir: string | undefined;
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
    if (stateDir) {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
    stateDir = undefined;
  });
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  async function createRetainedAndActiveStores() {
    const fixtureStateDir = tempDirs.make("openclaw-cleanup-deleted-agent-");
    setTestEnvValue("OPENCLAW_STATE_DIR", fixtureStateDir);
    const activeStore = path.join(fixtureStateDir, "agents", "main", "sessions", "sessions.json");
    const retainedStore = path.join(
      fixtureStateDir,
      "agents",
      "retired",
      "sessions",
      "sessions.json",
    );
    for (const [agentId, storePath] of [
      ["main", activeStore],
      ["retired", retainedStore],
    ] as const) {
      await replaceSessionEntry(
        { agentId, storePath, sessionKey: `agent:${agentId}:main` },
        {
          sessionId: `${agentId}-session`,
          updatedAt: 1,
          pluginExtensions: { fixture: { active: true } },
        },
      );
    }
    closeOpenClawAgentDatabasesForTest();
    const retainedDatabase = path.join(
      fixtureStateDir,
      "agents",
      "retired",
      "agent",
      "openclaw-agent.sqlite",
    );
    const before = await fs.readFile(retainedDatabase);
    const operationId = randomUUID();
    beginAgentDeletionJournal(
      {
        agentId: "retired",
        operationId,
        agentDir: path.dirname(retainedDatabase),
        sessionsDir: path.dirname(retainedStore),
        workspaceDir: path.join(fixtureStateDir, "workspace-retired"),
        databasePaths: [retainedDatabase],
        deleteFiles: false,
      },
      { env: process.env },
    );
    runOpenClawStateWriteTransaction(
      (database) => completeAgentDeletionJournalInDatabase(database, "retired", operationId),
      { env: process.env },
    );
    return { activeStore, retainedStore, retainedDatabase, before };
  }

  it("leaves entries unchanged when cleanup finds no plugin-owned state", async () => {
    stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-cleanup-noop-"),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
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
    stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cleanup-admission-"),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
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

  it("skips a retained deleted-agent store while cleaning an active sibling", async () => {
    const { activeStore, retainedStore, retainedDatabase, before } =
      await createRetainedAndActiveStores();

    const result = await runPluginHostCleanup({
      cfg: { agents: { ownership: "explicit", entries: { main: {} } } },
      registry: createEmptyPluginRegistry(),
      pluginId: "fixture",
      reason: "disable",
      sessionStoreTargets: [
        { agentId: "retired", storePath: retainedStore },
        { agentId: "main", storePath: activeStore },
      ],
    });

    expect(result).toEqual({ cleanupCount: 1, failures: [] });
    expect(
      loadSessionEntry({ agentId: "main", storePath: activeStore, sessionKey: "agent:main:main" })
        ?.pluginExtensions,
    ).toBeUndefined();
    expect(await fs.readFile(retainedDatabase)).toEqual(before);
  });

  it("still cleans an active store when the retained-deletion snapshot read rejects", async () => {
    const { activeStore, retainedStore, retainedDatabase, before } =
      await createRetainedAndActiveStores();
    const snapshotRead = vi
      .spyOn(agentDeletionDiscovery, "listRetainedDeletedAgentIdsForCleanup")
      .mockRejectedValueOnce(new Error("snapshot read rejected"));
    try {
      const result = await runPluginHostCleanup({
        cfg: { agents: { ownership: "explicit", entries: { main: {} } } },
        registry: createEmptyPluginRegistry(),
        pluginId: "fixture",
        reason: "disable",
        sessionStoreTargets: [
          { agentId: "retired", storePath: retainedStore },
          { agentId: "main", storePath: activeStore },
        ],
      });

      expect(result.cleanupCount).toBe(1);
      expect(result.failures).toEqual([
        expect.objectContaining({ pluginId: "fixture", hookId: "session-store" }),
      ]);
      expect(
        loadSessionEntry({ agentId: "main", storePath: activeStore, sessionKey: "agent:main:main" })
          ?.pluginExtensions,
      ).toBeUndefined();
      expect(await fs.readFile(retainedDatabase)).toEqual(before);
    } finally {
      snapshotRead.mockRestore();
    }
  });

  it("preserves deleted logical rows in an active-owned shared store", async () => {
    const fixtureStateDir = tempDirs.make("openclaw-cleanup-deleted-shared-");
    setTestEnvValue("OPENCLAW_STATE_DIR", fixtureStateDir);
    const sharedStore = path.join(fixtureStateDir, "shared", "sessions.json");
    const retiredDatabase = openOpenClawAgentDatabase({ agentId: "retired", env: process.env });
    const retiredPath = retiredDatabase.path;
    for (const agentId of ["main", "retired"] as const) {
      await replaceSessionEntry(
        { agentId, storePath: sharedStore, sessionKey: `agent:${agentId}:main` },
        {
          sessionId: `${agentId}-shared`,
          updatedAt: 1,
          pluginExtensions: { fixture: { active: true } },
        },
      );
    }
    closeOpenClawAgentDatabasesForTest();
    const retiredBefore = loadSessionEntry({
      agentId: "retired",
      storePath: sharedStore,
      sessionKey: "agent:retired:main",
    });
    const operationId = randomUUID();
    beginAgentDeletionJournal(
      {
        agentId: "retired",
        operationId,
        agentDir: path.dirname(retiredPath),
        sessionsDir: path.join(fixtureStateDir, "agents", "retired", "sessions"),
        workspaceDir: path.join(fixtureStateDir, "workspace-retired"),
        databasePaths: [retiredPath],
        deleteFiles: false,
      },
      { env: process.env },
    );
    runOpenClawStateWriteTransaction(
      (database) => completeAgentDeletionJournalInDatabase(database, "retired", operationId),
      { env: process.env },
    );

    const result = await runPluginHostCleanup({
      cfg: {
        agents: { ownership: "explicit", entries: { main: {} } },
        session: { store: sharedStore },
      },
      registry: createEmptyPluginRegistry(),
      pluginId: "fixture",
      reason: "disable",
      sessionStoreTargets: [
        { agentId: "retired", storePath: sharedStore },
        { agentId: "main", storePath: sharedStore },
      ],
    });

    expect(result).toEqual({ cleanupCount: 1, failures: [] });
    expect(
      loadSessionEntry({ agentId: "main", storePath: sharedStore, sessionKey: "agent:main:main" })
        ?.pluginExtensions,
    ).toBeUndefined();
    expect(
      loadSessionEntry({
        agentId: "retired",
        storePath: sharedStore,
        sessionKey: "agent:retired:main",
      }),
    ).toEqual(retiredBefore);
  });

  it("does not silently skip an unfinished deletion fence", async () => {
    const fixtureStateDir = tempDirs.make("openclaw-cleanup-deletion-held-");
    setTestEnvValue("OPENCLAW_STATE_DIR", fixtureStateDir);
    const storePath = path.join(fixtureStateDir, "agents", "retired", "sessions", "sessions.json");
    await replaceSessionEntry(
      { agentId: "retired", storePath, sessionKey: "agent:retired:main" },
      {
        sessionId: "retired-session",
        updatedAt: 1,
        pluginExtensions: { fixture: { active: true } },
      },
    );
    closeOpenClawAgentDatabasesForTest();
    const databasePath = path.join(
      fixtureStateDir,
      "agents",
      "retired",
      "agent",
      "openclaw-agent.sqlite",
    );
    const before = await fs.readFile(databasePath);
    beginAgentDeletionJournal(
      {
        agentId: "retired",
        operationId: randomUUID(),
        agentDir: path.dirname(databasePath),
        sessionsDir: path.dirname(storePath),
        workspaceDir: path.join(fixtureStateDir, "workspace-retired"),
        databasePaths: [databasePath],
        deleteFiles: false,
      },
      { env: process.env },
    );

    const result = await runPluginHostCleanup({
      cfg: { agents: { ownership: "explicit", entries: { main: {} } } },
      registry: createEmptyPluginRegistry(),
      pluginId: "fixture",
      reason: "disable",
      sessionStoreTargets: [{ agentId: "retired", storePath }],
    });

    expect(result.cleanupCount).toBe(0);
    expect(result.failures).toEqual([
      expect.objectContaining({ pluginId: "fixture", hookId: "session-store" }),
    ]);
    expect(await fs.readFile(databasePath)).toEqual(before);
  });

  it.each(["cancelled", "already-cleared", "locked", "revoked", "committed"] as const)(
    "revalidates queued cleanup and counts only committed changes (%s)",
    async (mode) => {
      stateDir = await fs.realpath(
        await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cleanup-queued-")),
      );
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
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
      registry.agentHarnesses.push({
        pluginId: "fixture",
        source: "test",
        harness: {
          id: "fixture-harness",
          label: "Fixture harness",
          supports: () => ({ supported: true }),
          runAttempt: async () => {
            throw new Error("unused test harness");
          },
        },
      });
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
        expect(
          [...SQLITE_SESSION_WRITER_QUEUES.values()].reduce(
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
        release.resolve();
        await settled;
      }
    },
  );

  it("can defer persistent session-state cleanup to an atomic owner", async () => {
    stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-cleanup-deferred-"),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
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
      stateDir = await fs.mkdtemp(
        path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-cleanup-opaque-"),
      );
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
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
      closeOpenClawAgentDatabasesForTest();
      const target = loadSessionEntry({ sessionKey: targetKey, storePath });
      expect(target?.pluginExtensions).toEqual({ other: { state: { preserved: true } } });
      expect(target?.pluginNextTurnInjections).toBeUndefined();
      expect(loadSessionEntry({ sessionKey: siblingKey, storePath })).toEqual(siblingBefore);
    },
  );

  it.each(["shared-session", "signal:group: Opaque"])(
    "matches runtime session ID %s case-insensitively without interpreting it as a key",
    async (runtimeSessionId) => {
      stateDir = await fs.mkdtemp(
        path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-cleanup-multistore-"),
      );
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
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
    },
  );

  it("clears shared custom SQLite stores for each resolved agent", async () => {
    stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-cleanup-shared-custom-"),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
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
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
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
    stateDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-host-cleanup-locked-harness-"),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const storePath = path.join(stateDir, "sessions.json");
    const updatedAt = 100;
    const registry = createEmptyPluginRegistry();
    for (const harnessId of ["fixture-harness-a", "fixture-harness-b"]) {
      registry.agentHarnesses.push({
        pluginId: "fixture-plugin",
        source: "test",
        harness: {
          id: harnessId,
          label: harnessId,
          supports: () => ({ supported: true }),
          runAttempt: async () => {
            throw new Error("unused test harness");
          },
        },
      });
    }
    registry.agentHarnesses.push({
      pluginId: "other-plugin",
      source: "test",
      harness: {
        id: "other-harness",
        label: "other-harness",
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("unused test harness");
        },
      },
    });
    const seedEntries: Record<string, SessionEntry> = {
      "agent:main:harness-a:locked": {
        sessionId: "locked-session-a",
        updatedAt,
        agentHarnessId: "fixture-harness-a",
        modelSelectionLocked: true,
        pluginExtensions: {
          "fixture-plugin": {
            supervision: {
              sourceThreadId: "native-thread-a",
              modelLocked: true,
            },
          },
        },
      } satisfies SessionEntry,
      "agent:main:harness-b:locked": {
        sessionId: "locked-session-b",
        updatedAt,
        agentHarnessId: "fixture-harness-b",
        modelSelectionLocked: true,
        pluginExtensions: {
          "fixture-plugin": {
            supervision: {
              sourceThreadId: "native-thread-b",
              modelLocked: true,
            },
          },
        },
      } satisfies SessionEntry,
      "agent:main:other-harness:locked": {
        sessionId: "other-locked-session",
        updatedAt,
        agentHarnessId: "other-harness",
        modelSelectionLocked: true,
        pluginExtensions: {
          "fixture-plugin": { transient: true },
        },
      } satisfies SessionEntry,
      "agent:main:ordinary": {
        sessionId: "ordinary-session",
        updatedAt,
        pluginExtensions: {
          "fixture-plugin": { transient: true },
        },
      } satisfies SessionEntry,
    };
    for (const [sessionKey, entry] of Object.entries(seedEntries)) {
      await replaceSessionEntry({ storePath, sessionKey }, entry);
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
    expect(readEntry("agent:main:harness-a:locked")).toMatchObject({
      updatedAt,
      agentHarnessId: "fixture-harness-a",
      modelSelectionLocked: true,
      pluginExtensions: {
        "fixture-plugin": {
          supervision: { sourceThreadId: "native-thread-a", modelLocked: true },
        },
      },
    });
    expect(readEntry("agent:main:harness-b:locked")).toMatchObject({
      updatedAt,
      agentHarnessId: "fixture-harness-b",
      modelSelectionLocked: true,
      pluginExtensions: {
        "fixture-plugin": {
          supervision: { sourceThreadId: "native-thread-b", modelLocked: true },
        },
      },
    });
    expect(readEntry("agent:main:other-harness:locked")?.pluginExtensions).toBeUndefined();
    expect(readEntry("agent:main:ordinary")?.pluginExtensions).toBeUndefined();
  });
});
