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
  it("preserves the draft for connected toolbar aborts", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "chat.abort": { aborted: true },
      },
      chatRunId: "run-main",
      chatMessage: "next prompt",
      sessionKey: "agent:main",
    });

    await handleAbortChat(host, { preserveDraft: true });

    expect(host.request).toHaveBeenCalledWith("chat.abort", {
      runId: "run-main",
      sessionKey: "agent:main",
    });
    expect(host.chatMessage).toBe("next prompt");
    expect(host.chatRunId).toBe("run-main");
  });

  it("aborts the exact selected session when no browser run id exists", async () => {
    const request = vi.fn(async () => ({ abortedRunId: null, status: "aborted" }));
    const sessionKey = "agent:main:openclaw-weixin:direct:wechat-user";
    const host = makeChatHost({
      client: clientWithRequest(request),
      chatRunId: null,
      chatMessage: "/stop",
      sessionKey,
      sessionsResult: createSessionsResult([
        row(sessionKey, { hasActiveRun: true, status: "running" }),
      ]),
    });

    await handleAbortChat(host);

    expect(request).toHaveBeenCalledWith("sessions.abort", {
      key: sessionKey,
      clearQueued: true,
    });
    expect(request).not.toHaveBeenCalledWith("chat.abort", expect.anything());
    expect(host.chatMessage).toBe("");
  });

  it("keeps selected global aborts on the compatible key-only request", async () => {
    const request = vi.fn(async () => ({ abortedRunId: null, status: "aborted" }));
    const host = makeChatHost({
      client: clientWithRequest(request),
      chatRunId: null,
      chatMessage: "/stop",
      sessionKey: "global",
      assistantAgentId: "work",
      agentsList: { defaultId: "main" },
      sessionsResult: createSessionsResult([
        row("global", { hasActiveRun: true, agentId: "work" } as Partial<GatewaySessionRow>),
      ]),
    });

    await handleAbortChat(host);

    expect(request).toHaveBeenCalledWith("sessions.abort", {
      key: "global",
      agentId: "work",
    });
  });

  it.each([
    {
      name: "clears queues for a per-sender agent main session",
      scope: "per-sender",
      expected: {
        key: "agent:work:main",
        clearQueued: true,
      },
    },
    {
      name: "keeps a global-scope agent main alias on the compatible request",
      scope: "global",
      expected: {
        key: "agent:work:main",
        agentId: "work",
      },
    },
  ] as const)("$name", async ({ scope, expected }) => {
    const request = vi.fn(async () => ({ abortedRunId: null, status: "aborted" }));
    const sessionKey = "agent:work:main";
    const host = makeChatHost({
      client: clientWithRequest(request),
      chatRunId: null,
      sessionKey,
      agentsList: { defaultId: "main", mainKey: "main", scope },
      sessionsResult: createSessionsResult([
        row(sessionKey, { hasActiveRun: true, status: "running" }),
      ]),
    });

    await handleAbortChat(host);

    expect(request).toHaveBeenCalledWith("sessions.abort", expected);
  });

  it.each(["/stop", "stop", "esc", "abort", "wait", "exit"])(
    "clears the typed stop command %s after aborting the active run",
    async (message) => {
      const host = makeChatHost({
        requestHandlers: {
          "chat.abort": { aborted: true },
        },
        chatRunId: "run-main",
        chatMessage: message,
        sessionKey: "agent:main",
      });

      await handleSendChat(host);

      expect(host.request).toHaveBeenCalledWith("chat.abort", {
        runId: "run-main",
        sessionKey: "agent:main",
      });
      expect(host.chatMessage).toBe("");
    },
  );

  it("blocks a typed stop before aborting when the operator lacks write scope", async () => {
    const host = makeChatHost({
      requestHandlers: {},
      chatRunId: "run-main",
      chatMessage: "/stop",
      hello: gatewayHelloForMethods(["chat.abort"], ["operator.read"]),
      sessionKey: "agent:main",
      chatRunError: { summary: "Previous run failed" },
    });

    await handleSendChat(host);

    expect(host.request).not.toHaveBeenCalled();
    expect(host.lastError).toBeTruthy();
    expect(host.chatError).toBe(host.lastError);
    expect(host.chatMessage).toBe("/stop");
    expect(host.chatRunError).toEqual({ summary: "Previous run failed" });
  });

  it("queues a typed exact-run stop while disconnected", async () => {
    const request = vi.fn();
    const client = clientWithRequest(request);
    const host = makeChatHost({
      client,
      connected: false,
      chatRunId: "run-main",
      chatMessage: "/stop",
      sessionKey: "agent:main",
    });

    await handleSendChat(host);

    expect(host.pendingAbort).toEqual({
      sourceClient: client,
      recoveryScope: client.recoveryScope,
      runId: "run-main",
      sessionKey: "agent:main",
      conversation: { sessionKey: "agent:main" },
    });
    expect(host.chatMessage).toBe("");
    expect(request).not.toHaveBeenCalled();
  });

  it("queues the active run abort while disconnected", async () => {
    const client = clientWithRequest(vi.fn());
    const host = makeChatHost({
      client,
      connected: false,
      chatRunId: "run-main",
      chatMessage: "draft",
      sessionKey: "agent:main",
    });

    await handleAbortChat(host);

    expect(host.pendingAbort).toEqual({
      sourceClient: client,
      recoveryScope: client.recoveryScope,
      runId: "run-main",
      sessionKey: "agent:main",
      conversation: { sessionKey: "agent:main" },
    });
    expect(host.chatMessage).toBe("");
    expect(host.chatRunId).toBe("run-main");
  });

  it("does not queue an unversioned session stop while disconnected", async () => {
    const request = vi.fn();
    const client = clientWithRequest(request);
    const sessionKey = "agent:main:telegram:direct:queued-user";
    const host = makeChatHost({
      client,
      connected: false,
      chatRunId: null,
      chatMessage: "draft",
      sessionKey,
      sessionsResult: createSessionsResult([
        row(sessionKey, { hasActiveRun: true }),
        row("agent:other", { hasActiveRun: true }),
      ]),
    });

    await handleAbortChat(host);

    expect(host.pendingAbort).toBeUndefined();
    expect(host.chatMessage).toBe("draft");
    expect(request).not.toHaveBeenCalled();
  });

  it("does not queue an unversioned global stop while disconnected", async () => {
    const request = vi.fn();
    const client = clientWithRequest(request);
    const host = makeChatHost({
      client,
      connected: false,
      chatRunId: null,
      chatMessage: "draft",
      sessionKey: "global",
      assistantAgentId: "work",
      agentsList: { defaultId: "main" },
      sessionsResult: createSessionsResult([
        row("global", { hasActiveRun: true, agentId: "work" } as Partial<GatewaySessionRow>),
      ]),
    });

    await handleAbortChat(host);

    expect(host.pendingAbort).toBeUndefined();
    expect(host.chatMessage).toBe("draft");
    expect(request).not.toHaveBeenCalled();
  });

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

  it("keeps the draft when disconnected without an active run", async () => {
    const host = makeChatHost({
      connected: false,
      chatRunId: null,
      chatMessage: "draft",
    });

    await handleAbortChat(host);

    expect(host.pendingAbort).toBeUndefined();
    expect(host.chatMessage).toBe("draft");
  });
});
