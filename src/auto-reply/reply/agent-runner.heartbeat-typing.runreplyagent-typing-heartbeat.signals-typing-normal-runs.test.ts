import { describe, expect, it, vi } from "vitest";
import {
  createMinimalRun,
  getRunEmbeddedPiAgentMock,
  installRunReplyAgentTypingHeartbeatTestHooks,
} from "./agent-runner.heartbeat-typing.test-harness.js";

const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();

describe("runReplyAgent typing (heartbeat)", () => {
  installRunReplyAgentTypingHeartbeatTestHooks();

  it("signals typing for normal runs", async () => {
    const onPartialReply = vi.fn();
    runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedPiAgentParams) => {
      await params.onPartialReply?.({ text: "hi" });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run, typing } = createMinimalRun({
      opts: { isHeartbeat: false, onPartialReply },
    });
    await run();

    expect(onPartialReply).toHaveBeenCalled();
    expect(typing.startTypingOnText).toHaveBeenCalledWith("hi");
    expect(typing.startTypingLoop).toHaveBeenCalled();
  });
  it("signals typing even without consumer partial handler", async () => {
    runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedPiAgentParams) => {
      await params.onPartialReply?.({ text: "hi" });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run, typing } = createMinimalRun({
      typingMode: "message",
    });
    await run();

    expect(typing.startTypingOnText).toHaveBeenCalledWith("hi");
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });
  it("never signals typing for heartbeat runs", async () => {
    const onPartialReply = vi.fn();
    runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedPiAgentParams) => {
      await params.onPartialReply?.({ text: "hi" });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run, typing } = createMinimalRun({
      opts: { isHeartbeat: true, onPartialReply },
    });
    await run();

    expect(onPartialReply).toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });
  it("suppresses partial streaming for NO_REPLY", async () => {
    const onPartialReply = vi.fn();
    runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedPiAgentParams) => {
      await params.onPartialReply?.({ text: "NO_REPLY" });
      return { payloads: [{ text: "NO_REPLY" }], meta: {} };
    });

    const { run, typing } = createMinimalRun({
      opts: { isHeartbeat: false, onPartialReply },
      typingMode: "message",
    });
    await run();

    expect(onPartialReply).not.toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });
  it("does not start typing on assistant message start without prior text in message mode", async () => {
    runEmbeddedPiAgentMock.mockImplementationOnce(async (params: EmbeddedPiAgentParams) => {
      await params.onAssistantMessageStart?.();
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const { run, typing } = createMinimalRun({
      typingMode: "message",
    });
    await run();

    // Typing only starts when there's actual renderable text, not on message start alone
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
  });
  it("starts typing from reasoning stream in thinking mode", async () => {
    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: {
        onPartialReply?: (payload: { text?: string }) => Promise<void> | void;
        onReasoningStream?: (payload: { text?: string }) => Promise<void> | void;
      }) => {
        await params.onReasoningStream?.({ text: "Reasoning:\n_step_" });
        await params.onPartialReply?.({ text: "hi" });
        return { payloads: [{ text: "final" }], meta: {} };
      },
    );

    const { run, typing } = createMinimalRun({
      typingMode: "thinking",
    });
    await run();

    expect(typing.startTypingLoop).toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
  });
  it("suppresses typing in never mode", async () => {
    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: { onPartialReply?: (payload: { text?: string }) => void }) => {
        params.onPartialReply?.({ text: "hi" });
        return { payloads: [{ text: "final" }], meta: {} };
      },
    );

    const { run, typing } = createMinimalRun({
      typingMode: "never",
    });
    await run();

    expect(typing.startTypingOnText).not.toHaveBeenCalled();
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });
});
