// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { sessionsResult as sessionListFixture } from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient as clientWithRequest } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { installOutboxBrowserStorage } from "./outbox-browser.test-support.ts";
import { handleAbortChat, hasAbortableSessionRun } from "./run-lifecycle.ts";

beforeEach(() => {
  installOutboxBrowserStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function createSessionsResult(sessions: GatewaySessionRow[]): SessionsListResult {
  return { ...sessionListFixture(sessions, 0), path: "" };
}

function row(key: string, overrides?: Partial<GatewaySessionRow>): GatewaySessionRow {
  return {
    key,
    kind: "direct",
    updatedAt: null,
    ...overrides,
  };
}

describe("handleAbortChat", () => {
  it.each([
    { action: "toolbar", message: "next prompt" },
    { action: "typed", message: "/stop" },
    { action: "typed", message: "stop" },
    { action: "read-only", message: "/stop" },
    { action: "offline", message: "/stop" },
  ] as const)("handles a stop during a run via $action ($message)", async ({ action, message }) => {
    const host = makeChatHost({
      requestHandlers:
        action === "read-only"
          ? {}
          : { "chat.abort": { aborted: true }, "sessions.abort": { status: "aborted" } },
      connected: action !== "offline",
      chatRunId: "run-main",
      chatMessage: message,
      sessionKey: "agent:main",
      ...(action === "read-only"
        ? {
            hello: gatewayHelloForMethods(["chat.abort"], ["operator.read"]),
            chatRunError: { summary: "Previous run failed" },
          }
        : {}),
    });
    if (action === "toolbar") {
      await handleAbortChat(host, { preserveDraft: true });
    } else {
      await handleSendChat(host);
    }
    if (action === "read-only") {
      expect(host.request).not.toHaveBeenCalled();
      expect(host.lastError).toBeTruthy();
      expect(host.chatError).toBe(host.lastError);
      expect(host.chatRunError).toEqual({ summary: "Previous run failed" });
    } else if (action === "offline") {
      expect(host.pendingAbort).toEqual({
        sourceClient: host.client,
        recoveryScope: host.client?.recoveryScope,
        runId: "run-main",
        sessionKey: "agent:main",
        conversation: { sessionKey: "agent:main" },
      });
      expect(host.request).not.toHaveBeenCalled();
    } else if (action === "typed") {
      expect(host.request).toHaveBeenCalledWith("sessions.abort", {
        key: "agent:main",
        clearQueued: true,
      });
      expect(host.request).not.toHaveBeenCalledWith("chat.abort", expect.anything());
    } else {
      expect(host.request).toHaveBeenCalledWith("chat.abort", {
        runId: "run-main",
        sessionKey: "agent:main",
      });
    }
    expect(host.chatMessage).toBe(action === "toolbar" || action === "read-only" ? message : "");
    expect(host.chatRunId).toBe("run-main");
  });

  it.each(["current", "terminal", "replacement"] as const)(
    "keeps a typed-stop failure with its originating run (%s)",
    async (scenario) => {
      const response = Promise.withResolvers<never>();
      const request = vi.fn(() => response.promise);
      const host = makeChatHost({
        client: clientWithRequest(request),
        connected: true,
        chatRunId: "run-a",
        chatMessage: "/stop",
        sessionKey: "agent:main",
      });
      const sending = handleSendChat(host);
      expect(request).toHaveBeenCalledWith("sessions.abort", {
        key: "agent:main",
        clearQueued: true,
      });
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
    },
  );

  it.each([
    { key: "agent:main:openclaw-weixin:direct:wechat-user", scope: "per-sender", connected: true },
    { key: "global", scope: "global", connected: true },
    { key: "agent:work:main", scope: "per-sender", connected: true },
    { key: "agent:work:main", scope: "global", connected: true },
    { key: "agent:main:telegram:direct:queued-user", scope: "per-sender", connected: false },
  ] as const)(
    "targets $key in $scope scope (connected: $connected)",
    async ({ key, scope, connected }) => {
      const request = vi.fn(async () => ({ abortedRunId: null, status: "aborted" }));
      const host = makeChatHost({
        client: clientWithRequest(request),
        connected,
        chatRunId: null,
        chatMessage: connected ? "/stop" : "draft",
        sessionKey: key,
        ...(key === "global" ? { assistantAgentId: "work" } : {}),
        agentsList: { defaultId: "main", mainKey: "main", scope },
        sessionsResult: createSessionsResult([
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
        expect(request).toHaveBeenCalledWith("sessions.abort", {
          key,
          ...(scope === "global" ? { agentId: "work" } : { clearQueued: true }),
        });
        expect(request).not.toHaveBeenCalledWith("chat.abort", expect.anything());
        expect(host.chatMessage).toBe("");
      } else {
        expect(host.pendingAbort).toBeUndefined();
        expect(host.chatMessage).toBe("draft");
        expect(request).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    {
      name: "ignores stale active-run flags once the current session is terminal",
      selected: { hasActiveRun: true, status: "done" as const },
    },
    {
      name: "ignores stale running status once the gateway reports no active run",
      selected: { hasActiveRun: false, status: "running" as const },
    },
  ])("$name", ({ selected }) => {
    const host = makeChatHost({
      chatRunId: null,
      sessionKey: "agent:main",
      sessionsResult: createSessionsResult([
        row("agent:main", selected),
        row("agent:other", { hasActiveRun: true, status: "running" }),
      ]),
    });

    expect(hasAbortableSessionRun(host)).toBe(false);
  });
});
