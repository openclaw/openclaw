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
import { createOwnershipHarness } from "./registry-ownership.test-support.js";
import type { PluginRegistry } from "./registry-types.js";

type CleanupOptions = Partial<Parameters<typeof runPluginHostCleanup>[0]>;
type Harness = PluginRegistry["agentHarnesses"][number];

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

  const cleanup = (overrides: CleanupOptions) =>
    runPluginHostCleanup({
      cfg: {},
      registry: createEmptyPluginRegistry(),
      reason: "disable",
      ...overrides,
    });
  async function expectCleanup(overrides: CleanupOptions, cleanupCount = 1) {
    expect(await cleanup(overrides)).toEqual({ cleanupCount, failures: [] });
  }

  function store(storePath = path.join(stateDir, "sessions.json"), agentId?: string) {
    const scope = (sessionKey: string) => ({ storePath, sessionKey, agentId });
    return {
      storePath,
      read: (key: string) => loadSessionEntry(scope(key)),
      write: (key: string, sessionId: string, overrides: Partial<SessionEntry> = {}) =>
        replaceSessionEntry(scope(key), { sessionId, updatedAt, ...overrides }),
      clean: (overrides: CleanupOptions, count = 1) =>
        expectCleanup({ cfg: { session: { store: storePath } }, ...overrides }, count),
    };
  }

  const preserved = { other: { state: { preserved: true } } };
  const cleanupState = { cleanup: { state: { active: true } } };
  const injections = (id: string): SessionEntry["pluginNextTurnInjections"] => ({
    cleanup: [
      { id, pluginId: "cleanup", text: id, placement: "append_context", createdAt: updatedAt },
    ],
  });

  const harnessRegistration = (pluginId: string, id: string): Harness => ({
    pluginId,
    source: "test",
    harness: createOwnershipHarness(id),
  });

  it("cleans healthy agent state without opening a refused agent store", async () => {
    const { storePath, read, write } = store(undefined, "main");
    const refusedStore = path.join(stateDir, "cleaner.sqlite");
    await write("agent:main:main", "healthy", { pluginExtensions: { fixture: { active: true } } });
    recordAgentDatabaseAdmissions([
      {
        agentId: "cleaner",
        paths: [refusedStore],
        embeddedOwnerId: "main",
        code: "agent-database-ownership-mismatch",
        reason: "Refused agent cleaner",
        repairHint: "Inspect the copy.",
      },
    ]);
    try {
      await expectCleanup({
        pluginId: "fixture",
        sessionStoreTargets: [
          { agentId: "cleaner", storePath: refusedStore },
          { agentId: "main", storePath },
        ],
      });
      expect(read("agent:main:main")?.pluginExtensions).toBeUndefined();
      await expect(fs.stat(refusedStore)).rejects.toMatchObject({ code: "ENOENT" });
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
      const retiredDb = shared
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
      const before = shared ? loadSessionEntry(retired) : await fs.readFile(retiredDb);
      const operationId = randomUUID();
      beginAgentDeletionJournal(
        {
          agentId: "retired",
          operationId,
          agentDir: path.dirname(retiredDb),
          sessionsDir: path.join(stateDir, "agents", "retired", "sessions"),
          workspaceDir: path.join(stateDir, "workspace-retired"),
          databasePaths: [retiredDb],
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
        expect(shared ? loadSessionEntry(retired) : await fs.readFile(retiredDb)).toEqual(before);
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
      const { clean, read, write } = store();
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

      await clean({ pluginId: "cleanup", reason: "delete", sessionKey: filter });
      await closeOpenClawAgentDatabasesAsync();
      const after = read(targetKey);
      expect(after?.pluginExtensions).toEqual(preserved);
      expect(after?.pluginNextTurnInjections).toBeUndefined();
      expect(read(siblingKey)).toEqual(siblingBefore);
    },
  );

  it.each([false, true])(
    "cleans opaque runtime IDs across agent stores (shared: %s)",
    async (shared) => {
      const runtimeSessionId = "signal:group: Opaque";
      const sharedPath = path.join(stateDir, "custom", "sessions.json");
      const scopedStore = (id: string) =>
        store(
          shared ? sharedPath : path.join(stateDir, "agents", id, "sessions", "sessions.json"),
          id,
        );
      const first = scopedStore("a");
      const second = scopedStore("b");
      const cfg = {
        session: { store: first.storePath },
        agents: {
          entries: { a: {}, b: {} },
          defaults: { sessionStore: { agentId: "a" } },
        },
      };
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
      const before = first.read(targetKey);
      await first.clean(
        { reason: "reset", sessionKey: targetKey, skipPersistentSessionState: true },
        0,
      );
      expect(first.read(targetKey)).toEqual(before);

      await first.clean(
        {
          cfg,
          pluginId: "cleanup",
          sessionKey: runtimeSessionId.toUpperCase(),
          sessionStoreTargets: shared
            ? undefined
            : [
                { agentId: "a", storePath: first.storePath },
                { agentId: "b", storePath: second.storePath },
              ],
        },
        2,
      );
      const firstMain = first.read(targetKey);
      const secondOther = second.read(secondKey);
      expect(firstMain?.pluginExtensions).toEqual(preserved);
      expect(firstMain?.pluginNextTurnInjections).toBeUndefined();
      expect(firstMain?.updatedAt).toBeGreaterThan(updatedAt);
      expect(first.read(unrelatedKey)).toEqual(unrelatedEntry);
      expect(secondOther?.pluginExtensions).toBeUndefined();
      expect(secondOther?.updatedAt).toBeGreaterThan(updatedAt);
    },
  );

  it("preserves locked sessions for every harness owned by a disabled plugin", async () => {
    const { clean, read, write } = store();
    const registry = createEmptyPluginRegistry();
    registry.agentHarnesses.push(
      ...["a", "b"].map((id) => harnessRegistration("fixture", id)),
      harnessRegistration("other-plugin", "other"),
    );
    const lockedState = (id: string) => ({
      updatedAt,
      agentHarnessId: id,
      modelSelectionLocked: true,
      pluginExtensions: {
        fixture: { supervision: { sourceThreadId: `thread-${id}`, modelLocked: true } },
      },
    });
    for (const id of ["a", "b", "other", "ordinary"]) {
      const entry = ["a", "b"].includes(id)
        ? lockedState(id)
        : {
            ...(id === "other" ? { agentHarnessId: id, modelSelectionLocked: true } : {}),
            pluginExtensions: { fixture: { transient: true } },
          };
      await write(`agent:main:${id}`, id, entry);
    }

    await clean(
      {
        registry,
        pluginId: "fixture",
      },
      2,
    );
    for (const id of ["a", "b"]) {
      expect(read(`agent:main:${id}`)).toMatchObject(lockedState(id));
    }
    expect(read("agent:main:other")?.pluginExtensions).toBeUndefined();
    expect(read("agent:main:ordinary")?.pluginExtensions).toBeUndefined();
    const before = read("agent:main:ordinary");
    await clean({ registry, pluginId: "fixture" }, 0);
    expect(read("agent:main:ordinary")).toEqual(before);
  });
});
