import { expect, test } from "vitest";
import { getSessionEntry } from "../config/sessions.js";
import { replaceSqliteSessionTranscriptEvents } from "../config/sessions/transcript-store.sqlite.js";
import { embeddedRunMock, rpcReq, seedGatewaySessionEntries } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  sessionLifecycleHookMocks,
  subagentLifecycleHookMocks,
  subagentLifecycleHookState,
  threadBindingMocks,
  acpManagerMocks,
  browserSessionTabMocks,
  bundleMcpRuntimeMocks,
  writeSingleLineSession,
  sessionStoreEntry,
  expectActiveRunCleanup,
  directSessionReq,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

test("sessions.delete rejects main and aborts active runs", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  await writeSingleLineSession(dir, "sess-active", "active");

  await seedGatewaySessionEntries({
    entries: {
      main: sessionStoreEntry("sess-main"),
      "discord:group:dev": sessionStoreEntry("sess-active"),
    },
  });

  embeddedRunMock.activeIds.add("sess-active");
  embeddedRunMock.waitResults.set("sess-active", true);

  const mainDelete = await directSessionReq("sessions.delete", { key: "main" });
  expect(mainDelete.ok).toBe(false);

  const deleted = await directSessionReq<{ ok: true; deleted: boolean }>("sessions.delete", {
    key: "discord:group:dev",
  });
  expect(deleted.ok).toBe(true);
  expect(deleted.payload?.deleted).toBe(true);
  expectActiveRunCleanup(
    "agent:main:discord:group:dev",
    ["agent:main:discord:group:dev", "sess-active"],
    "sess-active",
  );
  expect(bundleMcpRuntimeMocks.disposeSessionMcpRuntime).toHaveBeenCalledWith("sess-active");
  expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).toHaveBeenCalledTimes(1);
  expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).toHaveBeenCalledWith({
    sessionKeys: expect.arrayContaining([
      "discord:group:dev",
      "agent:main:discord:group:dev",
      "sess-active",
    ]),
    onWarn: expect.any(Function),
  });
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
});

test("sessions.delete limits plugin-runtime cleanup to sessions owned by that plugin", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-owned", "owned");
  await writeSingleLineSession(dir, "sess-foreign", "foreign");

  await seedGatewaySessionEntries({
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

test("sessions.delete closes ACP runtime handles before removing ACP sessions", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  await writeSingleLineSession(dir, "sess-acp", "acp");

  await seedGatewaySessionEntries({
    entries: {
      main: sessionStoreEntry("sess-main"),
      "discord:group:dev": sessionStoreEntry("sess-acp", {
        acp: {
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "runtime:delete",
          mode: "persistent",
          state: "idle",
          lastActivityAt: Date.now(),
        },
      }),
    },
  });
  const deleted = await directSessionReq<{ ok: true; deleted: boolean }>("sessions.delete", {
    key: "discord:group:dev",
  });
  expect(deleted.ok).toBe(true);
  expect(deleted.payload?.deleted).toBe(true);
  expect(acpManagerMocks.closeSession).toHaveBeenCalledWith({
    allowBackendUnavailable: true,
    cfg: expect.any(Object),
    discardPersistentState: true,
    requireAcpSession: false,
    reason: "session-delete",
    sessionKey: "agent:main:discord:group:dev",
  });
  expect(acpManagerMocks.cancelSession).toHaveBeenCalledWith({
    cfg: expect.any(Object),
    reason: "session-delete",
    sessionKey: "agent:main:discord:group:dev",
  });
});

test("sessions.delete emits session_end with deleted reason and no replacement", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  replaceSqliteSessionTranscriptEvents({
    agentId: "main",
    sessionId: "sess-delete",
    events: [
      {
        type: "message",
        id: "m-delete",
        message: { role: "user", content: "delete me" },
      },
    ],
  });

  await seedGatewaySessionEntries({
    entries: {
      main: sessionStoreEntry("sess-main"),
      "discord:group:delete": sessionStoreEntry("sess-delete", {}),
    },
  });

  const deleted = await directSessionReq<{ ok: true; deleted: boolean }>("sessions.delete", {
    key: "discord:group:delete",
  });
  expect(deleted.ok).toBe(true);
  expect(deleted.payload?.deleted).toBe(true);
  expect(sessionLifecycleHookMocks.runSessionEnd).toHaveBeenCalledTimes(1);
  expect(sessionLifecycleHookMocks.runSessionStart).not.toHaveBeenCalled();

  const [event, context] = (
    sessionLifecycleHookMocks.runSessionEnd.mock.calls as unknown as Array<[unknown, unknown]>
  )[0] ?? [undefined, undefined];
  expect(event).toMatchObject({
    sessionId: "sess-delete",
    sessionKey: "agent:main:discord:group:delete",
    reason: "deleted",
  });
  expect(event).not.toHaveProperty("transcriptLocator");
  expect((event as { nextSessionId?: string } | undefined)?.nextSessionId).toBeUndefined();
  expect(context).toMatchObject({
    sessionId: "sess-delete",
    sessionKey: "agent:main:discord:group:delete",
    agentId: "main",
  });
});

test("sessions.delete does not emit lifecycle events when nothing was deleted", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  await seedGatewaySessionEntries({
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
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-subagent", "hello");
  await seedGatewaySessionEntries({
    entries: {
      "agent:main:subagent:worker": sessionStoreEntry("sess-subagent"),
    },
  });

  const deleted = await directSessionReq<{ ok: true; deleted: boolean }>("sessions.delete", {
    key: "agent:main:subagent:worker",
  });
  expect(deleted.ok).toBe(true);
  expect(deleted.payload?.deleted).toBe(true);
  expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
  const event = (subagentLifecycleHookMocks.runSubagentEnded.mock.calls as unknown[][])[0]?.[0] as
    | { targetKind?: string; targetSessionKey?: string; reason?: string; outcome?: string }
    | undefined;
  expect(event).toMatchObject({
    targetSessionKey: "agent:main:subagent:worker",
    targetKind: "subagent",
    reason: "session-delete",
    outcome: "deleted",
  });
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
    targetSessionKey: "agent:main:subagent:worker",
    reason: "session-delete",
  });
});

test("sessions.delete can skip lifecycle hooks while still unbinding thread bindings", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-subagent", "hello");
  await seedGatewaySessionEntries({
    entries: {
      "agent:main:subagent:worker": sessionStoreEntry("sess-subagent"),
    },
  });

  const deleted = await directSessionReq<{ ok: true; deleted: boolean }>("sessions.delete", {
    key: "agent:main:subagent:worker",
    emitLifecycleHooks: false,
  });
  expect(deleted.ok).toBe(true);
  expect(deleted.payload?.deleted).toBe(true);
  expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
    targetSessionKey: "agent:main:subagent:worker",
    reason: "session-delete",
  });
});

test("sessions.delete directly unbinds thread bindings when hooks are unavailable", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-subagent", "hello");
  await seedGatewaySessionEntries({
    entries: {
      "agent:main:subagent:worker": sessionStoreEntry("sess-subagent"),
    },
  });
  subagentLifecycleHookState.hasSubagentEndedHook = false;

  const deleted = await directSessionReq<{ ok: true; deleted: boolean }>("sessions.delete", {
    key: "agent:main:subagent:worker",
  });
  expect(deleted.ok).toBe(true);
  expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
    targetSessionKey: "agent:main:subagent:worker",
    reason: "session-delete",
  });
});

test("sessions.delete returns unavailable when active run does not stop", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-active", "active");

  await seedGatewaySessionEntries({
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
    ["agent:main:discord:group:dev", "sess-active"],
    "sess-active",
  );
  expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).not.toHaveBeenCalled();

  expect(
    getSessionEntry({ agentId: "main", sessionKey: "agent:main:discord:group:dev" })?.sessionId,
  ).toBe("sess-active");

  ws.close();
});
