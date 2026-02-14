import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createMinimalRun,
  getRunEmbeddedPiAgentMock,
  installRunReplyAgentTypingHeartbeatTestHooks,
} from "./agent-runner.heartbeat-typing.test-harness.js";
const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();

describe("runReplyAgent typing (heartbeat)", () => {
  installRunReplyAgentTypingHeartbeatTestHooks();

  it("signals typing on block replies", async () => {
    const onBlockReply = vi.fn();
    runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedPiAgentParams) => {
      await params.onBlockReply?.({ text: "chunk", mediaUrls: [] });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run, typing } = createMinimalRun({
      typingMode: "message",
      blockStreamingEnabled: true,
      opts: { onBlockReply },
    });
    await run();

    expect(typing.startTypingOnText).toHaveBeenCalledWith("chunk");
    expect(onBlockReply).toHaveBeenCalled();
    const [blockPayload, blockOpts] = onBlockReply.mock.calls[0] ?? [];
    expect(blockPayload).toMatchObject({ text: "chunk", audioAsVoice: false });
    expect(blockOpts).toMatchObject({
      abortSignal: expect.any(AbortSignal),
      timeoutMs: expect.any(Number),
    });
  });
  it("signals typing on tool results", async () => {
    const onToolResult = vi.fn();
    runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedPiAgentParams) => {
      await params.onToolResult?.({ text: "tooling", mediaUrls: [] });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run, typing } = createMinimalRun({
      typingMode: "message",
      opts: { onToolResult },
    });
    await run();

    expect(typing.startTypingOnText).toHaveBeenCalledWith("tooling");
    expect(onToolResult).toHaveBeenCalledWith({
      text: "tooling",
      mediaUrls: [],
    });
  });
  it("skips typing for silent tool results", async () => {
    const onToolResult = vi.fn();
    runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedPiAgentParams) => {
      await params.onToolResult?.({ text: "NO_REPLY", mediaUrls: [] });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run, typing } = createMinimalRun({
      typingMode: "message",
      opts: { onToolResult },
    });
    await run();

    expect(typing.startTypingOnText).not.toHaveBeenCalled();
    expect(onToolResult).not.toHaveBeenCalled();
  });
  it("announces auto-compaction in verbose mode and tracks count", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "openclaw-compaction-")),
      "sessions.json",
    );
    const sessionEntry = { sessionId: "session", updatedAt: Date.now() };
    const sessionStore = { main: sessionEntry };

    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: {
        onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
      }) => {
        params.onAgentEvent?.({
          stream: "compaction",
          data: { phase: "end", willRetry: false },
        });
        return { payloads: [{ text: "final" }], meta: {} };
      },
    );

    const { run } = createMinimalRun({
      resolvedVerboseLevel: "on",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
    });
    const res = await run();
    expect(Array.isArray(res)).toBe(true);
    const payloads = res as { text?: string }[];
    expect(payloads[0]?.text).toContain("Auto-compaction complete");
    expect(payloads[0]?.text).toContain("count 1");
    expect(sessionStore.main.compactionCount).toBe(1);
  });
});
