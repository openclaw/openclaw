import fs from "node:fs/promises";
import { expect, test, vi } from "vitest";
import { loadSessionStore } from "../config/sessions.js";
import { enqueueSystemEvent, peekSystemEvents } from "../infra/system-events.js";
import { createActiveRun, createChatAbortContext } from "./server-methods/chat.abort.test-helpers.js";
import { embeddedRunMock, writeSessionStore } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  bootstrapCacheMocks,
  subagentLifecycleHookMocks,
  subagentLifecycleHookState,
  threadBindingMocks,
  acpRuntimeMocks,
  acpManagerMocks,
  browserSessionTabMocks,
  bundleMcpRuntimeMocks,
  writeSingleLineSession,
  sessionStoreEntry,
  expectActiveRunCleanup,
  directSessionReq,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, seedActiveMainSession } = setupGatewaySessionsTestHarness();

function expectResetAcpState(
  acp:
    | {
        backend?: string;
        agent?: string;
        runtimeSessionName?: string;
        identity?: {
          state?: string;
          acpxRecordId?: string;
          acpxSessionId?: string;
        };
        mode?: string;
        runtimeOptions?: {
          runtimeMode?: string;
          timeoutSeconds?: number;
        };
        cwd?: string;
        state?: string;
      }
    | undefined,
) {
  expect(acp?.backend).toBe("acpx");
  expect(acp?.agent).toBe("codex");
  expect(acp?.runtimeSessionName).toBe("runtime:reset");
  expect(acp?.identity?.state).toBe("pending");
  expect(acp?.identity?.acpxRecordId).toBe("agent:main:main");
  expect(acp?.identity?.acpxSessionId).toBeUndefined();
  expect(acp?.mode).toBe("persistent");
  expect(acp?.runtimeOptions?.runtimeMode).toBe("auto");
  expect(acp?.runtimeOptions?.timeoutSeconds).toBe(30);
  expect(acp?.cwd).toBe("/tmp/acp-session");
  expect(acp?.state).toBe("idle");
}

test("sessions.reset aborts active runs and clears queues", async () => {
  await seedActiveMainSession();
  enqueueSystemEvent("stale event via alias", { sessionKey: "main" });
  enqueueSystemEvent("stale event via canonical key", { sessionKey: "agent:main:main" });
  enqueueSystemEvent("stale event via session id", { sessionKey: "sess-main" });
  const waitCallCountAtSnapshotClear: number[] = [];
  bootstrapCacheMocks.clearBootstrapSnapshot.mockImplementation(() => {
    waitCallCountAtSnapshotClear.push(embeddedRunMock.waitCalls.length);
  });

  embeddedRunMock.activeIds.add("sess-main");
  embeddedRunMock.waitResults.set("sess-main", true);

  const reset = await directSessionReq<{ ok: true; key: string; entry: { sessionId: string } }>(
    "sessions.reset",
    {
      key: "main",
    },
  );
  expect(reset.ok).toBe(true);
  expect(reset.payload?.key).toBe("agent:main:main");
  expect(reset.payload?.entry.sessionId).not.toBe("sess-main");
  expectActiveRunCleanup("agent:main:main", ["main", "agent:main:main", "sess-main"], "sess-main");
  expect(peekSystemEvents("main")).toStrictEqual([]);
  expect(peekSystemEvents("agent:main:main")).toStrictEqual([]);
  expect(peekSystemEvents("sess-main")).toStrictEqual([]);
  expect(bundleMcpRuntimeMocks.disposeSessionMcpRuntime).toHaveBeenCalledWith("sess-main");
  expect(waitCallCountAtSnapshotClear).toEqual([1]);
  expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).toHaveBeenCalledTimes(1);
  const closeTabsCall = browserSessionTabMocks.closeTrackedBrowserTabsForSessions.mock
    .calls[0] as unknown as [{ sessionKeys?: string[]; onWarn?: unknown }] | undefined;
  const closeTabsParams = closeTabsCall?.[0];
  expect(closeTabsParams?.sessionKeys).toEqual(["main", "agent:main:main", "sess-main"]);
  expect(typeof closeTabsParams?.onWarn).toBe("function");
  expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
  expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledWith(
    {
      targetSessionKey: "agent:main:main",
      targetKind: "acp",
      reason: "session-reset",
      sendFarewell: true,
      outcome: "reset",
    },
    {
      childSessionKey: "agent:main:main",
    },
  );
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
    targetSessionKey: "agent:main:main",
    reason: "session-reset",
  });
});

test("sessions.abort repairs stale running row when no active run exists", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  await fs.writeFile(
    `${dir}/sess-stale.jsonl`,
    `${JSON.stringify({ message: { role: "assistant", content: "already done" } })}\n`,
    "utf-8",
  );
  await writeSessionStore({
    entries: {
      "telegram:group:-1003789377335:topic:2": sessionStoreEntry("sess-stale", {
        status: "running",
        updatedAt: Date.now() - 10 * 60_000,
        deliveryContext: {
          channel: "telegram",
          to: "-1003789377335",
          threadId: 2,
        },
        lastThreadId: 2,
      }),
    },
  });

  const abort = await directSessionReq<{ ok: true; status: string; abortedRunId: null }>(
    "sessions.abort",
    {
      key: "agent:main:telegram:group:-1003789377335:topic:2",
    },
    {
      context: createChatAbortContext(),
    },
  );

  expect(abort.ok).toBe(true);
  expect(abort.payload).toMatchObject({ status: "no-active-run", abortedRunId: null });
  const store = loadSessionStore(storePath, { skipCache: true });
  expect(store["agent:main:telegram:group:-1003789377335:topic:2"]).toMatchObject({
    status: "done",
    deliveryContext: {
      channel: "telegram",
      to: "-1003789377335",
      threadId: 2,
    },
    lastThreadId: 2,
  });
});

test("sessions.cleanup repairs stale running rows", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  await fs.writeFile(
    `${dir}/sess-cleanup-stale.jsonl`,
    `${JSON.stringify({ message: { role: "assistant", content: "already done" } })}\n`,
    "utf-8",
  );
  await writeSessionStore({
    entries: {
      "telegram:group:-1003789377335:topic:2": sessionStoreEntry("sess-cleanup-stale", {
        status: "running",
        updatedAt: Date.now() - 10 * 60_000,
      }),
    },
  });

  const cleanup = await directSessionReq<{ staleRunningRepaired: number }>("sessions.cleanup", {});

  expect(cleanup.ok).toBe(true);
  expect(cleanup.payload?.staleRunningRepaired).toBe(1);
  const store = loadSessionStore(storePath, { skipCache: true });
  expect(store["agent:main:telegram:group:-1003789377335:topic:2"]?.status).toBe("done");
});

test("sessions.cleanup does not close rows with active abort controllers", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      "telegram:group:-1003789377335:topic:2": sessionStoreEntry("sess-active", {
        status: "running",
        updatedAt: Date.now() - 10 * 60_000,
      }),
    },
  });

  const cleanup = await directSessionReq<{ staleRunningRepaired: number }>("sessions.cleanup", {}, {
    context: {
      chatAbortControllers: new Map([
        [
          "run-active",
          createActiveRun("agent:main:telegram:group:-1003789377335:topic:2", {
            sessionId: "sess-active",
          }),
        ],
      ]),
    },
  });

  expect(cleanup.ok).toBe(true);
  expect(cleanup.payload?.staleRunningRepaired).toBe(0);
  const store = loadSessionStore(storePath, { skipCache: true });
  expect(store["agent:main:telegram:group:-1003789377335:topic:2"]?.status).toBe("running");
});

test("sessions.reset preserves Telegram topic delivery context and thread id", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      "telegram:group:-1003789377335:topic:2": sessionStoreEntry("sess-topic", {
        status: "running",
        deliveryContext: {
          channel: "telegram",
          to: "-1003789377335",
          threadId: 2,
        },
        lastThreadId: 2,
      }),
    },
  });

  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: {
      sessionId: string;
      deliveryContext?: { channel?: string; to?: string; threadId?: number };
      lastThreadId?: number;
    };
  }>("sessions.reset", {
    key: "agent:main:telegram:group:-1003789377335:topic:2",
    reason: "reset",
  });

  expect(reset.ok).toBe(true);
  expect(reset.payload?.entry.sessionId).not.toBe("sess-topic");
  expect(reset.payload?.entry.deliveryContext).toMatchObject({
    channel: "telegram",
    to: "-1003789377335",
    threadId: 2,
  });
  expect(reset.payload?.entry.lastThreadId).toBe(2);
  const store = loadSessionStore(storePath, { skipCache: true });
  expect(store["agent:main:telegram:group:-1003789377335:topic:2"]?.deliveryContext).toMatchObject({
    channel: "telegram",
    to: "-1003789377335",
    threadId: 2,
  });
  expect(store["agent:main:telegram:group:-1003789377335:topic:2"]?.lastThreadId).toBe(2);
});

test("sessions.reset closes ACP runtime handles for ACP sessions", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  const prepareFreshSession = vi.fn(async () => {});
  acpRuntimeMocks.getAcpRuntimeBackend.mockReturnValue({
    id: "acpx",
    runtime: {
      prepareFreshSession,
    },
  });

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main", {
        acp: {
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "runtime:reset",
          identity: {
            state: "resolved",
            acpxRecordId: "agent:main:main",
            acpxSessionId: "backend-session-1",
            source: "status",
            lastUpdatedAt: Date.now(),
          },
          mode: "persistent",
          runtimeOptions: {
            runtimeMode: "auto",
            timeoutSeconds: 30,
          },
          cwd: "/tmp/acp-session",
          state: "idle",
          lastActivityAt: Date.now(),
        },
      }),
    },
  });
  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: {
      acp?: {
        backend?: string;
        agent?: string;
        runtimeSessionName?: string;
        identity?: {
          state?: string;
          acpxRecordId?: string;
          acpxSessionId?: string;
        };
        mode?: string;
        runtimeOptions?: {
          runtimeMode?: string;
          timeoutSeconds?: number;
        };
        cwd?: string;
        state?: string;
      };
    };
  }>("sessions.reset", {
    key: "main",
  });
  expect(reset.ok).toBe(true);
  expectResetAcpState(reset.payload?.entry.acp);
  expect(acpManagerMocks.closeSession).toHaveBeenCalledTimes(1);
  const closeSessionCall = acpManagerMocks.closeSession.mock.calls.at(0) as unknown as
    | [
        {
          allowBackendUnavailable?: boolean;
          cfg?: unknown;
          discardPersistentState?: boolean;
          requireAcpSession?: boolean;
          reason?: string;
          sessionKey?: string;
        },
      ]
    | undefined;
  const closeSessionParams = closeSessionCall?.[0] as
    | {
        allowBackendUnavailable?: boolean;
        cfg?: unknown;
        discardPersistentState?: boolean;
        requireAcpSession?: boolean;
        reason?: string;
        sessionKey?: string;
      }
    | undefined;
  expect(closeSessionParams?.allowBackendUnavailable).toBe(true);
  if (!closeSessionParams?.cfg) {
    throw new Error("expected closeSession config");
  }
  expect(closeSessionParams?.discardPersistentState).toBe(true);
  expect(closeSessionParams?.requireAcpSession).toBe(false);
  expect(closeSessionParams?.reason).toBe("session-reset");
  expect(closeSessionParams?.sessionKey).toBe("agent:main:main");
  expect(prepareFreshSession).toHaveBeenCalledWith({
    sessionKey: "agent:main:main",
  });
  const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
    string,
    {
      acp?: {
        backend?: string;
        agent?: string;
        runtimeSessionName?: string;
        identity?: {
          state?: string;
          acpxRecordId?: string;
          acpxSessionId?: string;
        };
        mode?: string;
        runtimeOptions?: {
          runtimeMode?: string;
          timeoutSeconds?: number;
        };
        cwd?: string;
        state?: string;
      };
    }
  >;
  expectResetAcpState(store["agent:main:main"]?.acp);
});

test("sessions.reset does not emit lifecycle events when key does not exist", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
    },
  });

  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: { sessionId: string };
  }>("sessions.reset", {
    key: "agent:main:subagent:missing",
  });

  expect(reset.ok).toBe(true);
  expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).not.toHaveBeenCalled();
});

test("sessions.reset emits subagent targetKind for subagent sessions", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-subagent", "hello");
  await writeSessionStore({
    entries: {
      "agent:main:subagent:worker": sessionStoreEntry("sess-subagent"),
    },
  });

  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: { sessionId: string };
  }>("sessions.reset", {
    key: "agent:main:subagent:worker",
  });
  expect(reset.ok).toBe(true);
  expect(reset.payload?.key).toBe("agent:main:subagent:worker");
  expect(reset.payload?.entry.sessionId).not.toBe("sess-subagent");
  expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledTimes(1);
  const event = (subagentLifecycleHookMocks.runSubagentEnded.mock.calls as unknown[][])[0]?.[0] as
    | { targetKind?: string; targetSessionKey?: string; reason?: string; outcome?: string }
    | undefined;
  expect(event?.targetSessionKey).toBe("agent:main:subagent:worker");
  expect(event?.targetKind).toBe("subagent");
  expect(event?.reason).toBe("session-reset");
  expect(event?.outcome).toBe("reset");
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
    targetSessionKey: "agent:main:subagent:worker",
    reason: "session-reset",
  });
});

test("sessions.reset directly unbinds thread bindings when hooks are unavailable", async () => {
  const { dir } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main"),
    },
  });
  subagentLifecycleHookState.hasSubagentEndedHook = false;

  const reset = await directSessionReq<{ ok: true; key: string }>("sessions.reset", {
    key: "main",
  });
  expect(reset.ok).toBe(true);
  expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
    targetSessionKey: "agent:main:main",
    reason: "session-reset",
  });
});
