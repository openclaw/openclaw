// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sessionsResult as sessionListFixture } from "../../lib/sessions/session-capability.test-support.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { row } from "./chat-outbox-recovery.test-support.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { installOutboxBrowserStorage } from "./outbox-browser.test-support.ts";
import { handleAbortChat } from "./run-lifecycle.ts";

beforeEach(installOutboxBrowserStorage);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const sessionAbort = { key: "agent:main", clearQueued: true };
const abortTarget = { runId: "run-main", sessionKey: "agent:main" };
const readOnly = {
  requestHandlers: {},
  hello: gatewayHelloForMethods(["chat.abort"], ["operator.read"]),
  chatRunError: { summary: "Previous run failed" },
};

it.each([
  { action: "toolbar", message: "next prompt" },
  { action: "typed", message: "/stop" },
  { action: "typed", message: "stop" },
  { action: "read-only", message: "/stop" },
  { action: "offline", message: "/stop" },
] as const)("handles a stop during a run via $action ($message)", async ({ action, message }) => {
  const host = makeChatHost({
    requestHandlers: { "chat.abort": { aborted: true }, "sessions.abort": { status: "aborted" } },
    connected: action !== "offline",
    chatRunId: "run-main",
    chatMessage: message,
    ...(action === "read-only" ? readOnly : {}),
  });
  await (action === "toolbar"
    ? handleAbortChat(host, { preserveDraft: true })
    : handleSendChat(host));
  if (action === "read-only") {
    expect(host.request).not.toHaveBeenCalled();
    expect(host.lastError).toBeTruthy();
    expect(host.chatError).toBe(host.lastError);
    expect(host.chatRunError).toEqual({ summary: "Previous run failed" });
  } else if (action === "offline") {
    expect(host.pendingAbort).toEqual({
      sourceClient: host.client,
      recoveryScope: host.client?.recoveryScope,
      ...abortTarget,
      conversation: { sessionKey: "agent:main" },
    });
    expect(host.request).not.toHaveBeenCalled();
  } else if (action === "typed") {
    expect(host.request).toHaveBeenCalledWith("sessions.abort", sessionAbort);
    expect(host.request).not.toHaveBeenCalledWith("chat.abort", expect.anything());
  } else {
    expect(host.request).toHaveBeenCalledWith("chat.abort", abortTarget);
  }
  expect(host.chatMessage).toBe(action === "toolbar" || action === "read-only" ? message : "");
  expect(host.chatRunId).toBe("run-main");
});

it.each(["current", "terminal", "replacement"] as const)("stop errors: %s", async (scenario) => {
  const response = Promise.withResolvers<never>();
  const host = makeChatHost({
    requestHandlers: { "sessions.abort": response.promise },
    chatRunId: "run-a",
    chatMessage: "/stop",
  });
  const sending = handleSendChat(host);
  expect(host.request).toHaveBeenCalledWith("sessions.abort", sessionAbort);
  if (scenario === "replacement") {
    host.chatRunId = "run-b";
  } else if (scenario === "terminal") {
    host.chatRunId = null;
    host.lastLocalTerminalReconcile = {
      sessionKey: host.sessionKey,
      runId: "run-a",
      phase: "interrupted",
      sessionStatus: "killed",
    };
  }
  response.reject(new Error("stop failed"));
  await sending;
  if (scenario === "current") {
    expect(host.chatError).toContain("stop failed");
  } else if (scenario === "terminal") {
    expect(host.chatRunError).toMatchObject({ runId: "run-a", summary: "stop failed" });
  } else {
    expect(host.chatError).toBeFalsy();
    expect(host.chatRunError).toBeFalsy();
  }
});

it.each([
  { key: "agent:main:openclaw-weixin:direct:wechat-user", scope: "per-sender", connected: true },
  { key: "global", scope: "global", connected: true },
  { key: "agent:work:main", scope: "per-sender", connected: true },
  { key: "agent:work:main", scope: "global", connected: true },
  { key: "agent:main:telegram:direct:queued-user", scope: "per-sender", connected: false },
] as const)("targets $key ($scope, connected: $connected)", async ({ key, scope, connected }) => {
  const host = makeChatHost({
    requestHandlers: { "sessions.abort": { abortedRunId: null, status: "aborted" } },
    connected,
    chatMessage: connected ? "/stop" : "draft",
    sessionKey: key,
    ...(key === "global" ? { assistantAgentId: "work" } : {}),
    agentsList: { defaultId: "main", mainKey: "main", scope },
    sessionsResult: sessionListFixture([
      row(key, {
        hasActiveRun: true,
        status: "running",
        ...(key === "global" ? { agentId: "work" } : {}),
      }),
      ...(!connected ? [row("agent:other", { hasActiveRun: true })] : []),
    ]),
  });
  await handleAbortChat(host);
  if (connected) {
    expect(host.request).toHaveBeenCalledWith("sessions.abort", {
      key,
      ...(scope === "global" ? { agentId: "work" } : { clearQueued: true }),
    });
    expect(host.request).not.toHaveBeenCalledWith("chat.abort", expect.anything());
    expect(host.chatMessage).toBe("");
  } else {
    expect(host.pendingAbort).toBeUndefined();
    expect(host.chatMessage).toBe("draft");
    expect(host.request).not.toHaveBeenCalled();
  }
});
