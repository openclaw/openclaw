import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerAgentRunContext, resetAgentRunContextForTest } from "../infra/agent-events.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createToolEventRecipientRegistry,
} from "./server-chat.js";

describe("agent event handler", () => {
  function createHarness(params?: {
    now?: number;
    resolveSessionKeyForRun?: (runId: string) => string | undefined;
  }) {
    const nowSpy =
      params?.now === undefined ? undefined : vi.spyOn(Date, "now").mockReturnValue(params.now);
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const nodeSendToSession = vi.fn();
    const agentRunSeq = new Map<string, number>();
    const chatRunState = createChatRunState();
    const toolEventRecipients = createToolEventRecipientRegistry();

    const handler = createAgentEventHandler({
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun: params?.resolveSessionKeyForRun ?? (() => undefined),
      clearAgentRunContext: vi.fn(),
      toolEventRecipients,
    });

    return {
      nowSpy,
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      toolEventRecipients,
      handler,
    };
  }

  function emitRun1AssistantText(
    harness: ReturnType<typeof createHarness>,
    text: string,
  ): ReturnType<typeof createHarness> {
    harness.chatRunState.registry.add("run-1", {
      sessionKey: "session-1",
      clientRunId: "client-1",
    });
    harness.handler({
      runId: "run-1",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text },
    });
    return harness;
  }

  function chatBroadcastCalls(broadcast: ReturnType<typeof vi.fn>) {
    return broadcast.mock.calls.filter(([event]) => event === "chat");
  }

  function sessionChatCalls(nodeSendToSession: ReturnType<typeof vi.fn>) {
    return nodeSendToSession.mock.calls.filter(([, event]) => event === "chat");
  }

  async function createTinyPngFile() {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chat-media-"));
    const filePath = path.join(tmpDir, "dot.png");
    const pngB64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
    await fs.writeFile(filePath, Buffer.from(pngB64, "base64"));
    return { tmpDir, filePath };
  }

  it("emits chat delta for assistant text-only events", () => {
    const { broadcast, nodeSendToSession, nowSpy } = emitRun1AssistantText(
      createHarness({ now: 1_000 }),
      "Hello world",
    );
    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(payload.state).toBe("delta");
    expect(payload.message?.content?.[0]?.text).toBe("Hello world");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it("does not emit chat delta for NO_REPLY streaming text", () => {
    const { broadcast, nodeSendToSession, nowSpy } = emitRun1AssistantText(
      createHarness({ now: 1_000 }),
      " NO_REPLY  ",
    );
    expect(chatBroadcastCalls(broadcast)).toHaveLength(0);
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(0);
    nowSpy?.mockRestore();
  });

  it("does not include NO_REPLY text in chat final message", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
      now: 2_000,
    });
    chatRunState.registry.add("run-2", { sessionKey: "session-2", clientRunId: "client-2" });

    handler({
      runId: "run-2",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "NO_REPLY" },
    });
    handler({
      runId: "run-2",
      seq: 2,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "end" },
    });

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as { state?: string; message?: unknown };
    expect(payload.state).toBe("final");
    expect(payload.message).toBeUndefined();
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it("includes media blocks with final assistant text when assistant events carry mediaUrls", async () => {
    const { tmpDir, filePath } = await createTinyPngFile();
    try {
      const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
        now: 3_000,
      });
      chatRunState.registry.add("run-media-1", {
        sessionKey: "session-media-1",
        clientRunId: "client-media-1",
      });

      handler({
        runId: "run-media-1",
        seq: 1,
        stream: "assistant",
        ts: Date.now(),
        data: { text: "Answer text", mediaUrls: [filePath] },
      });
      handler({
        runId: "run-media-1",
        seq: 2,
        stream: "lifecycle",
        ts: Date.now(),
        data: { phase: "end" },
      });

      await vi.waitFor(() => {
        const finals = chatBroadcastCalls(broadcast).filter(
          (call) => (call[1] as { state?: string }).state === "final",
        );
        expect(finals).toHaveLength(1);
      });

      const finalPayload = chatBroadcastCalls(broadcast).find(
        (call) => (call[1] as { state?: string }).state === "final",
      )?.[1] as
        | {
            message?: { content?: Array<Record<string, unknown>> };
          }
        | undefined;
      const content = finalPayload?.message?.content ?? [];
      const imageBlock = content.find((block) => block.type === "image");
      const textBlock = content.find((block) => block.type === "text");
      expect(imageBlock).toMatchObject({
        type: "image",
        source: {
          type: "base64",
        },
      });
      expect((textBlock as { text?: string } | undefined)?.text).toBe("Answer text");
      expect(sessionChatCalls(nodeSendToSession).length).toBeGreaterThanOrEqual(1);
      nowSpy?.mockRestore();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("emits image-only final message when assistant stream has media without text", async () => {
    const { tmpDir, filePath } = await createTinyPngFile();
    try {
      const { broadcast, chatRunState, handler } = createHarness({
        now: 3_500,
      });
      chatRunState.registry.add("run-media-only", {
        sessionKey: "session-media-only",
        clientRunId: "client-media-only",
      });

      handler({
        runId: "run-media-only",
        seq: 1,
        stream: "assistant",
        ts: Date.now(),
        data: { mediaUrls: [filePath] },
      });
      handler({
        runId: "run-media-only",
        seq: 2,
        stream: "lifecycle",
        ts: Date.now(),
        data: { phase: "end" },
      });

      await vi.waitFor(() => {
        const finals = chatBroadcastCalls(broadcast).filter(
          (call) => (call[1] as { state?: string }).state === "final",
        );
        expect(finals).toHaveLength(1);
      });

      const finalPayload = chatBroadcastCalls(broadcast).find(
        (call) => (call[1] as { state?: string }).state === "final",
      )?.[1] as
        | {
            message?: { content?: Array<Record<string, unknown>> };
          }
        | undefined;
      const content = finalPayload?.message?.content ?? [];
      expect(content.some((block) => block.type === "image")).toBe(true);
      expect(content.some((block) => block.type === "text")).toBe(false);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips unauthorized local media paths in final assistant message", async () => {
    const { broadcast, chatRunState, handler } = createHarness({
      now: 4_000,
    });
    chatRunState.registry.add("run-media-deny", {
      sessionKey: "session-media-deny",
      clientRunId: "client-media-deny",
    });

    handler({
      runId: "run-media-deny",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: {
        text: "safe text",
        mediaUrls: [path.join(process.cwd(), "AGENTS.md")],
      },
    });
    handler({
      runId: "run-media-deny",
      seq: 2,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "end" },
    });

    await vi.waitFor(() => {
      const finals = chatBroadcastCalls(broadcast).filter(
        (call) => (call[1] as { state?: string }).state === "final",
      );
      expect(finals).toHaveLength(1);
    });

    const finalPayload = chatBroadcastCalls(broadcast).find(
      (call) => (call[1] as { state?: string }).state === "final",
    )?.[1] as
      | {
          message?: { content?: Array<Record<string, unknown>> };
        }
      | undefined;
    const content = finalPayload?.message?.content ?? [];
    expect(content.some((block) => block.type === "image")).toBe(false);
    expect(content).toContainEqual({ type: "text", text: "safe text" });
  });

  it("cleans up agent run sequence tracking when lifecycle completes", () => {
    const { agentRunSeq, chatRunState, handler, nowSpy } = createHarness({ now: 2_500 });
    chatRunState.registry.add("run-cleanup", {
      sessionKey: "session-cleanup",
      clientRunId: "client-cleanup",
    });

    handler({
      runId: "run-cleanup",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "done" },
    });
    expect(agentRunSeq.get("run-cleanup")).toBe(1);

    handler({
      runId: "run-cleanup",
      seq: 2,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "end" },
    });

    expect(agentRunSeq.has("run-cleanup")).toBe(false);
    expect(agentRunSeq.has("client-cleanup")).toBe(false);
    nowSpy?.mockRestore();
  });

  it("routes tool events only to registered recipients when verbose is enabled", () => {
    const { broadcast, broadcastToConnIds, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool", { sessionKey: "session-1", verboseLevel: "on" });
    toolEventRecipients.add("run-tool", "conn-1");

    handler({
      runId: "run-tool",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "read", toolCallId: "t1" },
    });

    expect(broadcast).not.toHaveBeenCalled();
    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    resetAgentRunContextForTest();
  });

  it("broadcasts tool events to WS recipients even when verbose is off, but skips node send", () => {
    const { broadcastToConnIds, nodeSendToSession, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool-off", { sessionKey: "session-1", verboseLevel: "off" });
    toolEventRecipients.add("run-tool-off", "conn-1");

    handler({
      runId: "run-tool-off",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "read", toolCallId: "t2" },
    });

    // Tool events always broadcast to registered WS recipients
    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    // But node/channel subscribers should NOT receive when verbose is off
    const nodeToolCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(nodeToolCalls).toHaveLength(0);
    resetAgentRunContextForTest();
  });

  it("strips tool output when verbose is on", () => {
    const { broadcastToConnIds, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool-on", { sessionKey: "session-1", verboseLevel: "on" });
    toolEventRecipients.add("run-tool-on", "conn-1");

    handler({
      runId: "run-tool-on",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: {
        phase: "result",
        name: "exec",
        toolCallId: "t3",
        result: { content: [{ type: "text", text: "secret" }] },
        partialResult: { content: [{ type: "text", text: "partial" }] },
      },
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const payload = broadcastToConnIds.mock.calls[0]?.[1] as { data?: Record<string, unknown> };
    expect(payload.data?.result).toBeUndefined();
    expect(payload.data?.partialResult).toBeUndefined();
    resetAgentRunContextForTest();
  });

  it("keeps tool output when verbose is full", () => {
    const { broadcastToConnIds, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool-full", { sessionKey: "session-1", verboseLevel: "full" });
    toolEventRecipients.add("run-tool-full", "conn-1");

    const result = { content: [{ type: "text", text: "secret" }] };
    handler({
      runId: "run-tool-full",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: {
        phase: "result",
        name: "exec",
        toolCallId: "t4",
        result,
      },
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const payload = broadcastToConnIds.mock.calls[0]?.[1] as { data?: Record<string, unknown> };
    expect(payload.data?.result).toEqual(result);
    resetAgentRunContextForTest();
  });

  it("broadcasts fallback events to agent subscribers and node session", () => {
    const { broadcast, broadcastToConnIds, nodeSendToSession, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-fallback",
    });

    handler({
      runId: "run-fallback",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      data: {
        phase: "fallback",
        selectedProvider: "fireworks",
        selectedModel: "fireworks/minimax-m2p5",
        activeProvider: "deepinfra",
        activeModel: "moonshotai/Kimi-K2.5",
      },
    });

    expect(broadcastToConnIds).not.toHaveBeenCalled();
    const broadcastAgentCalls = broadcast.mock.calls.filter(([event]) => event === "agent");
    expect(broadcastAgentCalls).toHaveLength(1);
    const payload = broadcastAgentCalls[0]?.[1] as {
      sessionKey?: string;
      stream?: string;
      data?: Record<string, unknown>;
    };
    expect(payload.stream).toBe("lifecycle");
    expect(payload.data?.phase).toBe("fallback");
    expect(payload.sessionKey).toBe("session-fallback");
    expect(payload.data?.activeProvider).toBe("deepinfra");

    const nodeCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(nodeCalls).toHaveLength(1);
  });

  it("remaps chat-linked lifecycle runId to client runId", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-fallback",
    });
    chatRunState.registry.add("run-fallback-internal", {
      sessionKey: "session-fallback",
      clientRunId: "run-fallback-client",
    });

    handler({
      runId: "run-fallback-internal",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      data: {
        phase: "fallback",
        selectedProvider: "fireworks",
        selectedModel: "fireworks/minimax-m2p5",
        activeProvider: "deepinfra",
        activeModel: "moonshotai/Kimi-K2.5",
      },
    });

    const broadcastAgentCalls = broadcast.mock.calls.filter(([event]) => event === "agent");
    expect(broadcastAgentCalls).toHaveLength(1);
    const payload = broadcastAgentCalls[0]?.[1] as {
      runId?: string;
      sessionKey?: string;
      stream?: string;
      data?: Record<string, unknown>;
    };
    expect(payload.runId).toBe("run-fallback-client");
    expect(payload.stream).toBe("lifecycle");
    expect(payload.data?.phase).toBe("fallback");

    const nodeCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(nodeCalls).toHaveLength(1);
    const nodePayload = nodeCalls[0]?.[2] as { runId?: string };
    expect(nodePayload.runId).toBe("run-fallback-client");
  });

  it("uses agent event sessionKey when run-context lookup cannot resolve", () => {
    const { broadcast, handler } = createHarness({
      resolveSessionKeyForRun: () => undefined,
    });

    handler({
      runId: "run-fallback-session-key",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: "session-from-event",
      data: {
        phase: "fallback",
        selectedProvider: "fireworks",
        selectedModel: "fireworks/minimax-m2p5",
        activeProvider: "deepinfra",
        activeModel: "moonshotai/Kimi-K2.5",
      },
    });

    const broadcastAgentCalls = broadcast.mock.calls.filter(([event]) => event === "agent");
    expect(broadcastAgentCalls).toHaveLength(1);
    const payload = broadcastAgentCalls[0]?.[1] as { sessionKey?: string };
    expect(payload.sessionKey).toBe("session-from-event");
  });

  it("remaps chat-linked tool runId for non-full verbose payloads", () => {
    const { broadcastToConnIds, chatRunState, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-tool-remap",
    });

    chatRunState.registry.add("run-tool-internal", {
      sessionKey: "session-tool-remap",
      clientRunId: "run-tool-client",
    });
    registerAgentRunContext("run-tool-internal", {
      sessionKey: "session-tool-remap",
      verboseLevel: "on",
    });
    toolEventRecipients.add("run-tool-internal", "conn-1");

    handler({
      runId: "run-tool-internal",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: {
        phase: "result",
        name: "exec",
        toolCallId: "tool-remap-1",
        result: { content: [{ type: "text", text: "secret" }] },
      },
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const payload = broadcastToConnIds.mock.calls[0]?.[1] as { runId?: string };
    expect(payload.runId).toBe("run-tool-client");
    resetAgentRunContextForTest();
  });
});
