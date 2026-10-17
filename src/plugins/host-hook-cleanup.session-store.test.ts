import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  const updatedAt = 100;
  let stateDir: string;
  beforeEach(() => {
    stateDir = sessionDirs.make();
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  });
  afterEach(() => envSnapshot.restore());

  function cleanup(overrides: Partial<Parameters<typeof runPluginHostCleanup>[0]>) {
    return runPluginHostCleanup({
      cfg: {},
      registry: createEmptyPluginRegistry(),
      reason: "disable",
      ...overrides,
    });
  }

  function store(storePath = path.join(stateDir, "sessions.json"), agentId?: string) {
    const scope = (sessionKey: string) => ({ storePath, sessionKey, agentId });
    return {
      storePath,
      read: (key: string) => loadSessionEntry(scope(key)),
      write: (key: string, sessionId: string, overrides: Partial<SessionEntry> = {}) =>
        replaceSessionEntry(scope(key), { sessionId, updatedAt, ...overrides }),
    };
  }

  const preserved = { other: { state: { preserved: true } } };
  const cleanupState = { cleanup: { state: { active: true } } };
  function injections(id: string, createdAt = updatedAt): SessionEntry["pluginNextTurnInjections"] {
    return {
      cleanup: [{ id, pluginId: "cleanup", text: id, placement: "append_context", createdAt }],
    };
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
    const { storePath, read, write } = store();
    await write("agent:main:main", "session-id");
    const before = read("agent:main:main");

    const result = await cleanup({
      cfg: { session: { store: storePath } },
      pluginId: "noop-plugin",
    });

    expect(result).toEqual({ cleanupCount: 0, failures: [] });
    expect(read("agent:main:main")).toEqual(before);
  });

  it("cleans healthy agent state without opening a refused agent store", async () => {
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
      const result = await cleanup({
        pluginId: "fixture",
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
        const result = await cleanup({
          cfg: {
            agents: { ownership: "explicit", entries: { main: {} } },
            ...(shared ? { session: { store: active.storePath } } : {}),
          },
          pluginId: "fixture",
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
      const remainingState = { other: { state: true } };
      const concurrentPatch =
        mode === "already-cleared"
          ? { pluginExtensions: remainingState }
          : mode === "locked"
            ? { modelSelectionLocked: true, agentHarnessId: "fixture-harness" }
            : null;
      const blocker = patchSessionEntryCore(
        scope,
        async (entry) => {
          entered.resolve();
          await release.promise;
          return concurrentPatch ? Object.assign(entry, concurrentPatch) : null;
        },
        { replaceEntry: true, skipMaintenance: true },
      );
      await entered.promise;
      const queued = createDeferredCore();
      let cleanupAdmitted = false;
      const admit = agentWriteAdmission.runOpenClawAgentWriteAdmission;
      const admission = vi
        .spyOn(agentWriteAdmission, "runOpenClawAgentWriteAdmission")
        .mockImplementation((options, run, ...rest) => {
          const result = admit(
            options,
            (...args) => {
              cleanupAdmitted = true;
              return run(...args);
            },
            ...rest,
          );
          queued.resolve();
          return result;
        });
      let current = true;
      const revoked = new Error("session reset authority changed");
      const cleanupResult = cleanup({
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
      const settled = Promise.allSettled([blocker, cleanupResult]);
      try {
        await Promise.race([
          queued.promise,
          cleanupResult.then(() => {
            throw new Error("Cleanup completed before writer admission");
          }),
        ]);
        expect(cleanupAdmitted).toBe(false);
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
          expect(after?.pluginExtensions).toEqual(remainingState);
          expect(after?.updatedAt).toBeGreaterThan(100);
        } else {
          expect(after).toEqual(concurrentPatch ? { ...before, ...concurrentPatch } : before);
        }
      } finally {
        admission.mockRestore();
        release.resolve();
        await settled;
      }
    },
  );

  it("can defer persistent session-state cleanup to an atomic owner", async () => {
    const { storePath, read, write } = store();
    const pluginExtensions = { test: { state: { active: true } } };
    await write("agent:main:main", "session-id", { pluginExtensions });

    const result = await cleanup({
      cfg: { session: { store: storePath } },
      reason: "reset",
      sessionKey: "agent:main:main",
      skipPersistentSessionState: true,
    });

    expect(result).toEqual({ cleanupCount: 0, failures: [] });
    expect(read("agent:main:main")?.pluginExtensions).toEqual(pluginExtensions);
  });

  it.each([
    ["matrix:group", "!Room:server", "!room:server", "upper"],
    ["matrix:channel", "!Room:server", "!room:server", "same"],
    ["matrix:group", "!Room:server:thread:$Event", "!Room:server:thread:$event", "thread"],
    ["signal:group", "AbCdEf==", "abcdef==", "upper"],
  ])(
    "clears only the selected %s/%s session's plugin state",
    async (kind, target, sibling, filterMode) => {
      const prefix = `agent:main:${kind}:`;
      const targetKey = prefix + target;
      const siblingKey = prefix + sibling;
      const filter =
        filterMode === "upper"
          ? prefix.toUpperCase() + target
          : filterMode === "thread"
            ? targetKey.replace(":thread:", ":THREAD:")
            : targetKey;
      const { storePath, read, write } = store();
      for (const [sessionKey, sessionId] of [
        [targetKey, "target"],
        [siblingKey, "sibling"],
      ] as const) {
        await write(sessionKey, sessionId, {
          pluginExtensions: { cleanup: { state: { sessionId } }, ...preserved },
          pluginNextTurnInjections: injections(sessionId),
        });
      }
      const siblingBefore = read(siblingKey);
      expect(siblingBefore?.sessionId).toBe("sibling");

      const result = await cleanup({
        cfg: { session: { store: storePath } },
        pluginId: "cleanup",
        reason: "delete",
        sessionKey: filter,
      });

      expect(result).toEqual({ cleanupCount: 1, failures: [] });
      await closeOpenClawAgentDatabasesAsync();
      const after = read(targetKey);
      expect(after?.pluginExtensions).toEqual(preserved);
      expect(after?.pluginNextTurnInjections).toBeUndefined();
      expect(read(siblingKey)).toEqual(siblingBefore);
    },
  );

  it("matches a key-like runtime session ID case-insensitively without interpreting it as a key", async () => {
    const runtimeSessionId = "signal:group: Opaque";
    const first = store(path.join(stateDir, "agents", "a", "sessions", "sessions.json"));
    const second = store(path.join(stateDir, "agents", "b", "sessions", "sessions.json"));
    const targetKey = "agent:a:telegram:group:shared-room";
    const unrelatedKey = "agent:a:telegram:group:unrelated-room";
    const secondKey = "agent:b:telegram:group:shared-room";
    const unrelatedEntry: SessionEntry = {
      sessionId: "unrelated-session",
      updatedAt,
      delivery: { kind: "none" },
      pluginExtensions: { cleanup: { state: { keep: true } } },
    };
    await first.write(targetKey, runtimeSessionId, {
      pluginExtensions: { ...cleanupState, ...preserved },
      pluginNextTurnInjections: injections("remove"),
    });
    await first.write(unrelatedKey, unrelatedEntry.sessionId, unrelatedEntry);
    await second.write(secondKey, runtimeSessionId, { pluginExtensions: cleanupState });

    const result = await cleanup({
      cfg: { session: { store: first.storePath } },
      pluginId: "cleanup",
      sessionKey: runtimeSessionId.toUpperCase(),
      sessionStoreTargets: [
        { agentId: "a", storePath: first.storePath },
        { agentId: "b", storePath: second.storePath },
      ],
    });

    expect(result).toEqual({ cleanupCount: 2, failures: [] });
    const firstMain = first.read(targetKey);
    const secondOther = second.read(secondKey);
    expect(firstMain?.pluginExtensions).toEqual(preserved);
    expect(firstMain?.pluginNextTurnInjections).toBeUndefined();
    expect(firstMain?.updatedAt).toBeGreaterThan(updatedAt);
    expect(first.read(unrelatedKey)).toEqual(unrelatedEntry);
    expect(secondOther?.pluginExtensions).toBeUndefined();
    expect(secondOther?.updatedAt).toBeGreaterThan(updatedAt);
  });

  it("clears shared custom SQLite stores for each resolved agent", async () => {
    const sharedStorePath = path.join(stateDir, "custom", "sessions.json");
    const main = store(sharedStorePath, "main");
    const work = store(sharedStorePath, "work");
    await main.write("agent:main:main", "shared-session", { pluginExtensions: cleanupState });
    await work.write("agent:work:main", "shared-session", { pluginExtensions: cleanupState });

    const result = await cleanup({
      cfg: {
        session: { store: sharedStorePath },
        agents: {
          entries: { main: {}, work: {} },
          defaults: { sessionStore: { agentId: "main" } },
        },
      },
      pluginId: "cleanup",
    });

    expect(result).toEqual({ cleanupCount: 2, failures: [] });
    for (const [target, key] of [
      [main, "agent:main:main"],
      [work, "agent:work:main"],
    ] as const) {
      const after = target.read(key);
      expect(after?.pluginExtensions).toBeUndefined();
      expect(after?.updatedAt).toBeGreaterThan(updatedAt);
    }
  });

  it("preserves locked sessions for every harness owned by a disabled plugin", async () => {
    const { storePath, read, write } = store();
    const registry = createEmptyPluginRegistry();
    registry.agentHarnesses.push(
      ...["fixture-harness-a", "fixture-harness-b"].map((id) =>
        harnessRegistration("fixture-plugin", id),
      ),
      harnessRegistration("other-plugin", "other-harness"),
    );
    const lockedState = (suffix: string) => ({
      updatedAt,
      agentHarnessId: `fixture-harness-${suffix}`,
      modelSelectionLocked: true,
      pluginExtensions: {
        "fixture-plugin": {
          supervision: { sourceThreadId: `native-thread-${suffix}`, modelLocked: true },
        },
      },
    });
    for (const suffix of ["a", "b"]) {
      await write(
        `agent:main:harness-${suffix}:locked`,
        `locked-session-${suffix}`,
        lockedState(suffix),
      );
    }
    for (const [sessionKey, sessionId, agentHarnessId] of [
      ["agent:main:other-harness:locked", "other-locked-session", "other-harness"],
      ["agent:main:ordinary", "ordinary-session", undefined],
    ] as const) {
      await write(sessionKey, sessionId, {
        ...(agentHarnessId ? { agentHarnessId, modelSelectionLocked: true } : {}),
        pluginExtensions: { "fixture-plugin": { transient: true } },
      });
    }

    const result = await cleanup({
      cfg: { session: { store: storePath } },
      registry,
      pluginId: "fixture-plugin",
      sessionStoreTargets: [{ agentId: "main", storePath }],
    });

    expect(result).toEqual({ cleanupCount: 2, failures: [] });
    for (const suffix of ["a", "b"]) {
      expect(read(`agent:main:harness-${suffix}:locked`)).toMatchObject(lockedState(suffix));
    }
    expect(read("agent:main:other-harness:locked")?.pluginExtensions).toBeUndefined();
    expect(read("agent:main:ordinary")?.pluginExtensions).toBeUndefined();
  });
});
