// Session delete lifecycle tests protect transcript deletion, ACP metadata,
// active-run cleanup, hooks, thread bindings, and browser/MCP cleanup.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  readAcpSessionMeta,
  writeAcpSessionMetaForMigration,
} from "../acp/runtime/session-meta.js";
import { testing as replyRunRegistryTesting } from "../auto-reply/reply/reply-run-registry.js";
import { admitReplyTurn } from "../auto-reply/reply/reply-turn-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { embeddedRunMock, rpcReq, testState, writeSessionStore } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  sessionLifecycleHookMocks,
  subagentLifecycleHookMocks,
  subagentLifecycleHookState,
  threadBindingMocks,
  acpManagerMocks,
  browserSessionTabMocks,
  bundleMcpRuntimeMocks,
  sandboxLifecycleMocks,
  writeSingleLineSession,
  sessionStoreEntry,
  expectActiveRunCleanup,
  directSessionReq,
} from "./test/server-sessions.test-helpers.js";

const {
  createConfiguredGlobalAgentSessionStore,
  createSessionStoreDir,
  openClient,
  resetConfiguredGlobalAgentSessionStore,
} = setupGatewaySessionsTestHarness();

afterEach(() => {
  replyRunRegistryTesting.resetReplyRunRegistry();
  closeOpenClawStateDatabaseForTest();
});

function expectObject(value: unknown) {
  if (!value || typeof value !== "object") {
    throw new Error("expected object");
  }
}

type SessionDeleteRequest = {
  key: string;
  agentId?: string;
  deleteTranscript?: boolean;
  emitLifecycleHooks?: boolean;
};

async function expectSessionDeleteSucceeds(request: SessionDeleteRequest) {
  const deleted = await directSessionReq<{ ok: true; deleted: boolean }>(
    "sessions.delete",
    request,
  );
  expect(deleted.ok).toBe(true);
  expect(deleted.payload?.deleted).toBe(true);
  return deleted;
}

async function seedSubagentWorkerSession() {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-subagent", "hello");
  await writeSessionStore({
    entries: {
      "agent:main:subagent:worker": sessionStoreEntry("sess-subagent"),
    },
  });
}

function expectThreadBindingsUnbound(targetSessionKey: string) {
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
    targetSessionKey,
    reason: "session-delete",
  });
}

test("sessions.delete rejects main and aborts active runs", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  await writeSingleLineSession(dir, "sess-active", "active");

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
      "discord:group:dev": sessionStoreEntry("sess-active"),
    },
  });

  embeddedRunMock.activeIds.add("sess-active");
  embeddedRunMock.waitResults.set("sess-active", true);
  sandboxLifecycleMocks.cleanupSessionScopedSandboxForLifecycleEnd.mockImplementationOnce(
    async () => {
      const storePath = testState.sessionStorePath;
      if (!storePath) {
        throw new Error("expected session store path");
      }
      const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
        string,
        { sessionId?: string }
      >;
      expect(
        store["agent:main:discord:group:dev"]?.sessionId ?? store["discord:group:dev"]?.sessionId,
      ).toBe("sess-active");
      return {
        skipped: false,
        scopeKeys: [],
        removedContainers: 0,
        removedBrowsers: 0,
        removedWorkspaces: 0,
        failures: [],
      };
    },
  );

  const mainDelete = await directSessionReq("sessions.delete", { key: "main" });
  expect(mainDelete.ok).toBe(false);

  await expectSessionDeleteSucceeds({
    key: "discord:group:dev",
  });
  expectActiveRunCleanup(
    "agent:main:discord:group:dev",
    ["discord:group:dev", "agent:main:discord:group:dev", "sess-active"],
    "sess-active",
  );
  expect(bundleMcpRuntimeMocks.disposeSessionMcpRuntime).toHaveBeenCalledWith("sess-active");
  expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).toHaveBeenCalledTimes(1);
  const closeTabsCall = (
    browserSessionTabMocks.closeTrackedBrowserTabsForSessions.mock.calls as unknown as Array<
      [{ sessionKeys?: string[]; onWarn?: unknown }]
    >
  )[0]?.[0];
  expect(closeTabsCall?.sessionKeys).toHaveLength(3);
  expect(closeTabsCall?.sessionKeys).toContain("discord:group:dev");
  expect(closeTabsCall?.sessionKeys).toContain("agent:main:discord:group:dev");
  expect(closeTabsCall?.sessionKeys).toContain("sess-active");
  expect(typeof closeTabsCall?.onWarn).toBe("function");
  expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
  expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledWith(
    {
      targetSessionKey: "agent:main:discord:group:dev",
      targetKind: "acp",
      reason: "session-delete",
      sendFarewell: true,
      outcome: "deleted",
    },
    {
      childSessionKey: "agent:main:discord:group:dev",
    },
  );
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
    targetSessionKey: "agent:main:discord:group:dev",
    reason: "session-delete",
  });
  expect(sandboxLifecycleMocks.cleanupSessionScopedSandboxForLifecycleEnd).toHaveBeenCalledWith(
    expect.objectContaining({
      agentId: "main",
      reason: "session-delete",
      sessionKeys: expect.arrayContaining(["discord:group:dev", "agent:main:discord:group:dev"]),
    }),
  );
});

test("sessions.delete keeps the session with pending sandbox cleanup when lifecycle cleanup fails", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-delete-fail", "active");
  await writeSessionStore({
    entries: {
      "discord:group:cleanup": sessionStoreEntry("sess-delete-fail"),
    },
  });
  sandboxLifecycleMocks.cleanupSessionScopedSandboxForLifecycleEnd.mockResolvedValueOnce({
    skipped: false,
    scopeKeys: ["agent:main:discord:group:cleanup"],
    removedContainers: 0,
    removedBrowsers: 0,
    removedWorkspaces: 0,
    failures: [{ scopeKey: "agent:main:discord:group:cleanup", error: "permission denied" }],
  });

  const deleted = await directSessionReq("sessions.delete", {
    key: "discord:group:cleanup",
  });

  expect(deleted.ok).toBe(false);
  expect(deleted.error?.code).toBe("UNAVAILABLE");
  const storePath = testState.sessionStorePath;
  expect(storePath).toBeTruthy();
  const store = JSON.parse(await fs.readFile(storePath!, "utf-8")) as Record<
    string,
    {
      pendingSandboxLifecycleCleanupOwnerSessionIds?: string[];
      pendingSandboxLifecycleCleanupReason?: string;
      pendingSandboxLifecycleCleanupSessionKeys?: string[];
      sessionId?: string;
    }
  >;
  const entry = store["agent:main:discord:group:cleanup"] ?? store["discord:group:cleanup"];
  expect(entry?.sessionId).toBe("sess-delete-fail");
  expect(entry?.pendingSandboxLifecycleCleanupSessionKeys).toEqual(
    expect.arrayContaining(["discord:group:cleanup", "agent:main:discord:group:cleanup"]),
  );
  expect(entry?.pendingSandboxLifecycleCleanupReason).toBe("session-delete");
  expect(entry?.pendingSandboxLifecycleCleanupOwnerSessionIds).toEqual(["sess-delete-fail"]);
});

test("sessions.delete preserves a replacement session created during sandbox cleanup", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-delete-old", "old");
  await writeSingleLineSession(dir, "sess-delete-new", "new");
  await writeSessionStore({
    entries: {
      "agent:main:discord:group:replace": sessionStoreEntry("sess-delete-old"),
    },
  });
  sandboxLifecycleMocks.cleanupSessionScopedSandboxForLifecycleEnd.mockImplementationOnce(
    async () => {
      const storePath = testState.sessionStorePath;
      if (!storePath) {
        throw new Error("expected session store path");
      }
      const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<string, unknown>;
      store["agent:main:discord:group:replace"] = sessionStoreEntry("sess-delete-new");
      await fs.writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
      return {
        skipped: false,
        scopeKeys: ["agent:main:discord:group:replace"],
        removedContainers: 1,
        removedBrowsers: 0,
        removedWorkspaces: 1,
        failures: [],
      };
    },
  );

  const deleted = await directSessionReq<{ ok: true; deleted: boolean }>("sessions.delete", {
    key: "discord:group:replace",
  });

  expect(deleted.ok).toBe(true);
  expect(deleted.payload?.deleted).toBe(false);
  const storePath = testState.sessionStorePath;
  expect(storePath).toBeTruthy();
  const store = JSON.parse(await fs.readFile(storePath!, "utf-8")) as Record<
    string,
    { sessionId?: string }
  >;
  expect(store["agent:main:discord:group:replace"]?.sessionId).toBe("sess-delete-new");
  expect(sessionLifecycleHookMocks.runSessionEnd).not.toHaveBeenCalled();
});

test("sessions.delete waits reply admission while sandbox cleanup owns the session", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-delete-admission", "delete");
  await writeSessionStore({
    entries: {
      "agent:main:discord:group:delete-admission": sessionStoreEntry("sess-delete-admission"),
    },
  });
  let admitted: ReturnType<typeof admitReplyTurn> | undefined;
  sandboxLifecycleMocks.cleanupSessionScopedSandboxForLifecycleEnd.mockImplementationOnce(
    async () => {
      admitted = admitReplyTurn({
        sessionKey: "agent:main:discord:group:delete-admission",
        sessionId: "reply-during-delete",
        kind: "visible",
        resetTriggered: false,
      });
      let settled = false;
      void admitted.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      return {
        skipped: false,
        scopeKeys: ["agent:main:discord:group:delete-admission"],
        removedContainers: 0,
        removedBrowsers: 0,
        removedWorkspaces: 1,
        failures: [],
      };
    },
  );

  await expectSessionDeleteSucceeds({
    key: "discord:group:delete-admission",
  });
  const admission = await admitted;
  expect(admission?.status).toBe("owned");
  if (admission?.status === "owned") {
    expect(admission.operation.sessionId).toBe("reply-during-delete");
    admission.operation.complete();
  }
});

test("sessions.delete prevents a concurrent reset from recreating the deleted session", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:discord:group:delete-reset-race";
  await writeSingleLineSession(dir, "sess-delete-reset-race", "delete");
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry("sess-delete-reset-race"),
    },
  });

  let releaseDeleteCleanup: () => void = () => undefined;
  const deleteCleanupReleased = new Promise<void>((resolve) => {
    releaseDeleteCleanup = resolve;
  });
  let markDeleteCleanupStarted: () => void = () => undefined;
  const deleteCleanupStarted = new Promise<void>((resolve) => {
    markDeleteCleanupStarted = resolve;
  });
  const cleanupReasons: string[] = [];
  sandboxLifecycleMocks.cleanupSessionScopedSandboxForLifecycleEnd.mockImplementation(
    async (params) => {
      cleanupReasons.push(params.reason);
      if (params.reason === "session-delete") {
        markDeleteCleanupStarted();
        await deleteCleanupReleased;
      }
      return {
        skipped: false,
        scopeKeys: [sessionKey],
        removedContainers: 0,
        removedBrowsers: 0,
        removedWorkspaces: 1,
        failures: [],
      };
    },
  );

  const deletePromise = directSessionReq<{ ok: true; deleted: boolean }>("sessions.delete", {
    key: "discord:group:delete-reset-race",
  });
  await deleteCleanupStarted;

  const resetPromise = directSessionReq("sessions.reset", {
    key: "discord:group:delete-reset-race",
  });
  await Promise.resolve();
  expect(cleanupReasons).toEqual(["session-delete"]);

  releaseDeleteCleanup();
  const [deleted, reset] = await Promise.all([deletePromise, resetPromise]);

  expect(deleted.ok).toBe(true);
  expect(deleted.payload?.deleted).toBe(true);
  expect(reset.ok).toBe(false);
  expect(reset.error?.code).toBe("UNAVAILABLE");
  expect(cleanupReasons).toEqual(["session-delete"]);
  const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<string, unknown>;
  expect(store[sessionKey]).toBeUndefined();
});

test("sessions.delete preserves existing pending sandbox cleanup when pre-delete cleanup fails", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-delete-prep-fail", "active");
  await writeSessionStore({
    entries: {
      "discord:group:prep-fail": sessionStoreEntry("sess-delete-prep-fail", {
        pendingSandboxLifecycleCleanupOwnerSessionIds: ["old-session"],
        pendingSandboxLifecycleCleanupReason: "session-reset",
        pendingSandboxLifecycleCleanupSessionKeys: ["agent:main:discord:group:old-cleanup"],
      }),
    },
  });
  embeddedRunMock.activeIds.add("sess-delete-prep-fail");
  embeddedRunMock.waitResults.set("sess-delete-prep-fail", false);

  const deleted = await directSessionReq("sessions.delete", {
    key: "discord:group:prep-fail",
  });

  expect(deleted.ok).toBe(false);
  const storePath = testState.sessionStorePath;
  expect(storePath).toBeTruthy();
  const store = JSON.parse(await fs.readFile(storePath!, "utf-8")) as Record<
    string,
    {
      pendingSandboxLifecycleCleanupOwnerSessionIds?: string[];
      pendingSandboxLifecycleCleanupReason?: string;
      pendingSandboxLifecycleCleanupSessionKeys?: string[];
    }
  >;
  const entry = store["agent:main:discord:group:prep-fail"] ?? store["discord:group:prep-fail"];
  expect(entry?.pendingSandboxLifecycleCleanupSessionKeys).toEqual([
    "agent:main:discord:group:old-cleanup",
  ]);
  expect(entry?.pendingSandboxLifecycleCleanupReason).toBe("session-reset");
  expect(entry?.pendingSandboxLifecycleCleanupOwnerSessionIds).toEqual(["old-session"]);
  expect(sandboxLifecycleMocks.cleanupSessionScopedSandboxForLifecycleEnd).not.toHaveBeenCalled();
});

test("sessions.delete includes pending sandbox cleanup keys and usage lineage owners", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-pending", "pending");
  await writeSessionStore({
    entries: {
      "discord:group:pending": sessionStoreEntry("sess-pending", {
        pendingSandboxLifecycleCleanupSessionKeys: ["agent:main:discord:group:old"],
        pendingSandboxLifecycleCleanupOwnerSessionIds: ["old-owner-session"],
        usageFamilySessionIds: ["ancestor-session", "sess-pending"],
      }),
    },
  });

  await expectSessionDeleteSucceeds({
    key: "discord:group:pending",
  });

  expect(sandboxLifecycleMocks.cleanupSessionScopedSandboxForLifecycleEnd).toHaveBeenCalledWith(
    expect.objectContaining({
      ownerSessionIds: expect.arrayContaining([
        "old-owner-session",
        "ancestor-session",
        "sess-pending",
      ]),
      sessionKeys: expect.arrayContaining(["agent:main:discord:group:old"]),
    }),
  );
});

test("sessions.delete limits plugin-runtime cleanup to sessions owned by that plugin", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-owned", "owned");
  await writeSingleLineSession(dir, "sess-foreign", "foreign");

  await writeSessionStore({
    entries: {
      "agent:main:dreaming-narrative-owned": sessionStoreEntry("sess-owned", {
        pluginOwnerId: "memory-core",
      }),
      "agent:main:dreaming-narrative-foreign": sessionStoreEntry("sess-foreign", {
        pluginOwnerId: "other-plugin",
      }),
    },
  });

  const pluginClient = {
    connect: {
      scopes: ["operator.admin"],
    },
    internal: {
      pluginRuntimeOwnerId: "memory-core",
    },
  } as never;

  const denied = await directSessionReq(
    "sessions.delete",
    {
      key: "agent:main:dreaming-narrative-foreign",
    },
    {
      client: pluginClient,
    },
  );
  expect(denied.ok).toBe(false);
  expect(denied.error?.message).toContain("did not create it");

  const deleted = await directSessionReq<{ ok: true; deleted: boolean }>(
    "sessions.delete",
    {
      key: "agent:main:dreaming-narrative-owned",
    },
    {
      client: pluginClient,
    },
  );
  expect(deleted.ok).toBe(true);
  expect(deleted.payload?.deleted).toBe(true);
});

test("sessions.delete scopes selected global deletes to the requested agent", async () => {
  const globalStores = await createConfiguredGlobalAgentSessionStore({ writePrimeStore: true });

  await expectSessionDeleteSucceeds({
    key: "global",
    agentId: "work",
    deleteTranscript: false,
  });
  const mainStore = JSON.parse(await fs.readFile(globalStores.mainStorePath, "utf-8")) as {
    global?: { sessionId?: string };
  };
  const workStore = JSON.parse(await fs.readFile(globalStores.workStorePath, "utf-8")) as {
    global?: { sessionId?: string };
  };
  expect(mainStore.global?.sessionId).toBe("sess-main-global");
  expect(workStore.global).toBeUndefined();
  await resetConfiguredGlobalAgentSessionStore(globalStores);
});

test("sessions.delete closes ACP runtime handles before removing ACP sessions", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  await writeSingleLineSession(dir, "sess-acp", "acp");

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
      "discord:group:dev": sessionStoreEntry("sess-acp"),
    },
  });
  writeAcpSessionMetaForMigration({
    sessionKey: "agent:main:discord:group:dev",
    meta: {
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "runtime:delete",
      mode: "persistent",
      state: "idle",
      lastActivityAt: Date.now(),
    },
  });
  await expectSessionDeleteSucceeds({
    key: "discord:group:dev",
  });
  expect(acpManagerMocks.closeSession).toHaveBeenCalledTimes(1);
  const closeSessionCall = (
    acpManagerMocks.closeSession.mock.calls as unknown as Array<
      [
        {
          allowBackendUnavailable?: boolean;
          cfg?: unknown;
          discardPersistentState?: boolean;
          requireAcpSession?: boolean;
          reason?: string;
          sessionKey?: string;
        },
      ]
    >
  )[0]?.[0];
  expect(closeSessionCall?.allowBackendUnavailable).toBe(true);
  expectObject(closeSessionCall?.cfg);
  expect(closeSessionCall?.discardPersistentState).toBe(true);
  expect(closeSessionCall?.requireAcpSession).toBe(false);
  expect(closeSessionCall?.reason).toBe("session-delete");
  expect(closeSessionCall?.sessionKey).toBe("agent:main:discord:group:dev");

  expect(acpManagerMocks.cancelSession).toHaveBeenCalledTimes(1);
  const cancelSessionCall = (
    acpManagerMocks.cancelSession.mock.calls as unknown as Array<
      [{ cfg?: unknown; reason?: string; sessionKey?: string }]
    >
  )[0]?.[0];
  expectObject(cancelSessionCall?.cfg);
  expect(cancelSessionCall?.reason).toBe("session-delete");
  expect(cancelSessionCall?.sessionKey).toBe("agent:main:discord:group:dev");
  expect(readAcpSessionMeta({ sessionKey: "agent:main:discord:group:dev" })).toBeUndefined();
});

test("sessions.delete closes child ACP runtimes spawned from the deleted parent", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  await writeSingleLineSession(dir, "sess-parent", "parent");
  await writeSingleLineSession(dir, "sess-child", "child");

  const acpMeta = (recordId: string) => ({
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: `runtime:${recordId}`,
    mode: "oneshot" as const,
    state: "idle" as const,
    lastActivityAt: Date.now(),
  });

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
      "acp-parent": sessionStoreEntry("sess-parent"),
      "acp-child": sessionStoreEntry("sess-child", {
        spawnedBy: "agent:main:acp-parent",
      }),
    },
  });
  writeAcpSessionMetaForMigration({
    sessionKey: "agent:main:acp-parent",
    meta: acpMeta("agent:main:acp-parent"),
  });
  writeAcpSessionMetaForMigration({
    sessionKey: "agent:main:acp-child",
    meta: acpMeta("agent:main:acp-child"),
  });

  await expectSessionDeleteSucceeds({
    key: "acp-parent",
  });

  // Deleting the parent must also close its spawned ACP child, not just its own
  // runtime, otherwise the child's claude-agent-acp process is orphaned (#68916).
  const closedKeys = (
    acpManagerMocks.closeSession.mock.calls as unknown as Array<[{ sessionKey?: string }]>
  ).map((call) => call[0]?.sessionKey);
  expect(closedKeys).toContain("agent:main:acp-parent");
  expect(closedKeys).toContain("agent:main:acp-child");
  expect(readAcpSessionMeta({ sessionKey: "agent:main:acp-parent" })).toBeUndefined();
  expect(readAcpSessionMeta({ sessionKey: "agent:main:acp-child" })).toBeUndefined();
});

test("sessions.delete emits session_end with deleted reason and no replacement", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  const transcriptPath = path.join(dir, "sess-delete.jsonl");
  await fs.writeFile(
    transcriptPath,
    `${JSON.stringify({
      type: "message",
      id: "m-delete",
      message: { role: "user", content: "delete me" },
    })}\n`,
    "utf-8",
  );

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
      "discord:group:delete": sessionStoreEntry("sess-delete", {
        sessionFile: transcriptPath,
      }),
    },
  });

  await expectSessionDeleteSucceeds({
    key: "discord:group:delete",
  });
  expect(sessionLifecycleHookMocks.runSessionEnd).toHaveBeenCalledTimes(1);
  expect(sessionLifecycleHookMocks.runSessionStart).not.toHaveBeenCalled();

  const [event, context] = (
    sessionLifecycleHookMocks.runSessionEnd.mock.calls as unknown as Array<[unknown, unknown]>
  )[0] ?? [undefined, undefined];
  expect((event as { sessionId?: string } | undefined)?.sessionId).toBe("sess-delete");
  expect((event as { sessionKey?: string } | undefined)?.sessionKey).toBe(
    "agent:main:discord:group:delete",
  );
  expect((event as { reason?: string } | undefined)?.reason).toBe("deleted");
  expect((event as { transcriptArchived?: boolean } | undefined)?.transcriptArchived).toBe(true);
  expect((event as { sessionFile?: string } | undefined)?.sessionFile).toContain(".jsonl.deleted.");
  expect((event as { nextSessionId?: string } | undefined)?.nextSessionId).toBeUndefined();
  expect((context as { sessionId?: string } | undefined)?.sessionId).toBe("sess-delete");
  expect((context as { sessionKey?: string } | undefined)?.sessionKey).toBe(
    "agent:main:discord:group:delete",
  );
  expect((context as { agentId?: string } | undefined)?.agentId).toBe("main");
});

test("sessions.delete does not emit lifecycle events when nothing was deleted", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
    },
  });

  const deleted = await directSessionReq<{ ok: true; deleted: boolean }>("sessions.delete", {
    key: "agent:main:subagent:missing",
  });

  expect(deleted.ok).toBe(true);
  expect(deleted.payload?.deleted).toBe(false);
  expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).not.toHaveBeenCalled();
});

test("sessions.delete emits subagent targetKind for subagent sessions", async () => {
  await seedSubagentWorkerSession();

  await expectSessionDeleteSucceeds({
    key: "agent:main:subagent:worker",
  });
  expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
  const event = (subagentLifecycleHookMocks.runSubagentEnded.mock.calls as unknown[][])[0]?.[0] as
    | { targetKind?: string; targetSessionKey?: string; reason?: string; outcome?: string }
    | undefined;
  expect(event?.targetSessionKey).toBe("agent:main:subagent:worker");
  expect(event?.targetKind).toBe("subagent");
  expect(event?.reason).toBe("session-delete");
  expect(event?.outcome).toBe("deleted");
  expectThreadBindingsUnbound("agent:main:subagent:worker");
});

test("sessions.delete can skip lifecycle hooks while still unbinding thread bindings", async () => {
  await seedSubagentWorkerSession();

  await expectSessionDeleteSucceeds({
    key: "agent:main:subagent:worker",
    emitLifecycleHooks: false,
  });
  expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
  expectThreadBindingsUnbound("agent:main:subagent:worker");
});

test("sessions.delete directly unbinds thread bindings when hooks are unavailable", async () => {
  await seedSubagentWorkerSession();
  subagentLifecycleHookState.hasSubagentEndedHook = false;

  const deleted = await directSessionReq<{ ok: true; deleted: boolean }>("sessions.delete", {
    key: "agent:main:subagent:worker",
  });
  expect(deleted.ok).toBe(true);
  expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
  expectThreadBindingsUnbound("agent:main:subagent:worker");
});

test("sessions.delete returns unavailable when active run does not stop", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-active", "active");

  await writeSessionStore({
    entries: {
      "discord:group:dev": sessionStoreEntry("sess-active"),
    },
  });

  embeddedRunMock.activeIds.add("sess-active");
  embeddedRunMock.waitResults.set("sess-active", false);

  const { ws } = await openClient();

  const deleted = await rpcReq(ws, "sessions.delete", {
    key: "discord:group:dev",
  });
  expect(deleted.ok).toBe(false);
  expect(deleted.error?.code).toBe("UNAVAILABLE");
  expect(deleted.error?.message ?? "").toMatch(/still active/i);
  expectActiveRunCleanup(
    "agent:main:discord:group:dev",
    ["discord:group:dev", "agent:main:discord:group:dev", "sess-active"],
    "sess-active",
  );
  expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).not.toHaveBeenCalled();

  const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
    string,
    { sessionId?: string }
  >;
  expect(store["agent:main:discord:group:dev"]?.sessionId).toBe("sess-active");
  const filesAfterDeleteAttempt = await fs.readdir(dir);
  expect(
    filesAfterDeleteAttempt.filter((fileName) => fileName.startsWith("sess-active.jsonl.deleted.")),
  ).toEqual([]);

  ws.close();
});
