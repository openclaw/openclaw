import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as assistantIdentity from "../../app/assistant-identity.ts";
import { chatRunPresentation } from "./chat-run-presentation.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createSessionEventState, emitGatewayEvent } from "./chat-state.test-support.ts";

function chatEvent(state: ChatPageHost, runId: string, phase: string, text: string) {
  emitGatewayEvent(state, "chat", {
    sessionKey: state.sessionKey,
    runId,
    state: phase,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function agentEvent(
  state: ChatPageHost,
  runId: string,
  seq: number,
  stream: string,
  data: Record<string, unknown>,
) {
  emitGatewayEvent(state, "agent", {
    sessionKey: state.sessionKey,
    runId,
    seq,
    ts: seq,
    stream,
    data,
  });
}

function captureAnimationFrames() {
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => frames.delete(id));
  return { frames };
}

beforeEach(() => {
  vi.spyOn(assistantIdentity, "loadLocalAssistantIdentity").mockReturnValue({
    avatar: "data:image/png;base64,bG9jYWw=",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("chat run publication", () => {
  it("publishes growing tool output at its flush without republishing unchanged frame activity", () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { frames } = captureAnimationFrames();
    const paint = () => {
      const callbacks = Array.from(frames.values());
      frames.clear();
      for (const callback of callbacks) {
        callback(0);
      }
    };
    const { state } = createSessionEventState({
      chatRunId: "run",
      chatStream: "Existing answer",
      knownAgentRunIds: new Set(["run"]),
    });
    const run = chatRunPresentation(state);
    const activity = vi.fn();
    const text = vi.fn();
    onTestFinished(run.subscribeNonText(activity));
    onTestFinished(run.subscribe(text));
    const tool = (seq: number, phase: string) =>
      agentEvent(state, "run", seq, "tool", {
        toolCallId: "growing-tool",
        name: "read",
        phase,
        partialResult: `Progress ${seq}`,
      });
    tool(1, "start");
    vi.advanceTimersByTime(80);
    chatEvent(state, "run", "delta", "Answer 2");
    tool(2, "update");
    paint();
    activity.mockClear();
    text.mockClear();

    for (let seq = 3; seq <= 5; seq++) {
      chatEvent(state, "run", "delta", `Answer ${seq}`);
      tool(seq, "update");
      paint();
      expect(state.chatRunStartup).toMatchObject({ state: "activity", seq });
    }
    expect(text).toHaveBeenCalledTimes(3);
    expect(activity).not.toHaveBeenCalled();
    expect(state.chatStream).toBe("Answer 5");
    vi.advanceTimersByTime(80);
    expect(activity).toHaveBeenCalledOnce();
    expect(state.chatToolMessages[0]?.content).toContainEqual({
      type: "toolresult",
      name: "read",
      text: "Progress 5",
    });
  });

  it("publishes first observed analysis activity even without a tool-message or startup change", () => {
    const { frames } = captureAnimationFrames();
    const { state } = createSessionEventState({
      chatRunId: "run",
      knownAgentRunIds: new Set(),
      chatRunStartup: null,
    });
    const activity = vi.fn();
    onTestFinished(chatRunPresentation(state).subscribeNonText(activity));
    for (let seq = 1; seq <= 2; seq++) {
      agentEvent(state, "run", seq, "item", {
        itemId: "analysis",
        kind: "analysis",
        phase: "update",
        title: "Thinking",
      });
      const callbacks = Array.from(frames.values());
      frames.clear();
      for (const callback of callbacks) {
        callback(0);
      }
    }
    expect(state.knownAgentRunIds.has("run")).toBe(true);
    expect(state.chatRunStartup).toBeNull();
    expect(state.chatToolMessages).toEqual([]);
    expect(activity).toHaveBeenCalledOnce();
  });
});
