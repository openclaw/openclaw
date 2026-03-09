import { describe, expect, it, vi } from "vitest";

vi.mock("./chat-abort.js", () => ({
  abortChatRunById: vi.fn(() => ({ aborted: true })),
}));
vi.mock("./server-methods/chat-transcript-inject.js", () => ({
  appendInjectedAssistantMessageToTranscript: vi.fn(() => ({ ok: true })),
}));
vi.mock("./session-utils.js", () => ({
  loadSessionEntry: vi.fn(() => ({
    cfg: {},
    storePath: "/tmp/sessions.json",
    entry: { sessionFile: "/tmp/sess.jsonl" },
  })),
}));
vi.mock("../agents/agent-scope.js", () => ({
  resolveSessionAgentId: vi.fn(() => "main"),
}));
vi.mock("../config/sessions.js", () => ({
  resolveSessionFilePath: vi.fn(() => "/tmp/sess.jsonl"),
}));

const { createGatewayCloseHandler } = await import("./server-close.js");
const { abortChatRunById } = await import("./chat-abort.js");
const { appendInjectedAssistantMessageToTranscript } =
  await import("./server-methods/chat-transcript-inject.js");

describe("createGatewayCloseHandler", () => {
  it("aborts active chat runs and injects a restart notice before closing websocket clients", async () => {
    const broadcast = vi.fn();
    const socketClose = vi.fn();
    const handler = createGatewayCloseHandler({
      bonjourStop: null,
      tailscaleCleanup: null,
      canvasHost: null,
      canvasHostServer: null,
      stopChannel: vi.fn(async () => {}),
      pluginServices: null,
      cron: { stop: vi.fn() },
      heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() },
      updateCheckStop: vi.fn(),
      nodePresenceTimers: new Map(),
      broadcast,
      tickInterval: setInterval(() => {}, 1 << 30),
      healthInterval: setInterval(() => {}, 1 << 30),
      dedupeCleanup: setInterval(() => {}, 1 << 30),
      mediaCleanup: null,
      agentUnsub: null,
      heartbeatUnsub: null,
      chatRunState: { clear: vi.fn(), abortedRuns: new Map() },
      chatAbortControllers: new Map([
        [
          "run-1",
          {
            controller: new AbortController(),
            sessionId: "sess-1",
            sessionKey: "main",
            startedAtMs: 1,
            expiresAtMs: Date.now() + 60_000,
          },
        ],
      ]),
      chatRunBuffers: new Map(),
      chatDeltaSentAt: new Map(),
      removeChatRun: vi.fn(),
      agentRunSeq: new Map(),
      nodeSendToSession: vi.fn(),
      clients: new Set([{ socket: { close: socketClose } }]),
      configReloader: { stop: vi.fn(async () => {}) },
      browserControl: null,
      wss: { close: (cb: () => void) => cb() } as unknown as import("ws").WebSocketServer,
      httpServer: {
        close: (cb: (err?: Error) => void) => cb(),
      } as unknown as import("node:http").Server,
      httpServers: [],
    });

    await handler({ reason: "restart" });

    expect(abortChatRunById).toHaveBeenCalledWith(
      expect.objectContaining({ chatAbortControllers: expect.any(Map) }),
      expect.objectContaining({ runId: "run-1", sessionKey: "main", stopReason: "shutdown" }),
    );
    expect(appendInjectedAssistantMessageToTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        transcriptPath: "/tmp/sess.jsonl",
        idempotencyKey: "shutdown-abort:run-1",
      }),
    );
    expect(broadcast).toHaveBeenCalledWith("shutdown", expect.any(Object));
    expect(socketClose).toHaveBeenCalledWith(1012, "service restart");
  });
});
