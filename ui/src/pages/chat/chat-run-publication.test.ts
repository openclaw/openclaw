import { createEffect, createRoot, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as assistantIdentity from "../../app/assistant-identity.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { keepVolatileQueuedMessage, removeQueuedMessage } from "./chat-queue.ts";
import { chatRunPresentation } from "./chat-run-presentation.ts";
import { createChatPageStateContext } from "./chat-state-context.test-support.ts";
import { createChatState } from "./chat-state-controller.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createPageState } from "./chat-state-page.ts";
import { createSessionEventState, emitGatewayEvent } from "./chat-state.test-support.ts";
import { buildToolStreamIdentity } from "./tool-stream-identity.ts";
import { resetToolStream, resetToolStreamRun } from "./tool-stream-state.ts";

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
  it("publishes the first answer without a frame wait and coalesces continuing text", () => {
    const { frames } = captureAnimationFrames();
    const { state } = createSessionEventState({ chatRunId: "run", chatStream: "" });
    const observed: (string | null)[] = [];
    onTestFinished(chatRunPresentation(state).subscribe(() => observed.push(state.chatStream)));

    chatEvent(state, "run", "delta", "First answer");
    expect(observed).toEqual(["First answer"]);

    chatEvent(state, "run", "delta", "First answer continues");
    chatEvent(state, "run", "delta", "First answer continues further");
    expect(observed).toEqual(["First answer"]);
    const callbacks = Array.from(frames.values());
    frames.clear();
    for (const callback of callbacks) {
      callback(0);
    }
    expect(observed).toEqual(["First answer", "First answer continues further"]);
  });

  it("publishes against the previous flush deadline without adding idle gaps to the wait", () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    captureAnimationFrames();
    const { state } = createSessionEventState({ chatRunId: "run" });
    const run = chatRunPresentation(state);
    const invocation = vi.fn();
    onTestFinished(run.subscribeToolMessage("run", "call", invocation));
    const tool = (seq: number, phase: string) =>
      agentEvent(state, "run", seq, "tool", {
        toolCallId: "call",
        name: "exec",
        phase,
        partialResult: `Output ${seq}`,
        result: `Result ${seq}`,
      });
    tool(1, "start");
    vi.advanceTimersByTime(79);
    expect(invocation).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(invocation).toHaveBeenCalledOnce();
    invocation.mockClear();
    vi.advanceTimersByTime(20);
    tool(2, "update");
    vi.advanceTimersByTime(59);
    expect(invocation).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(invocation).toHaveBeenCalledOnce();
    expect(run.readToolMessage("run", "call")?.content).toContainEqual({
      type: "toolresult",
      name: "exec",
      text: "Output 2",
    });
    invocation.mockClear();
    vi.advanceTimersByTime(120);
    tool(3, "update");
    vi.advanceTimersByTime(0);
    expect(invocation).toHaveBeenCalledOnce();
    invocation.mockClear();
    vi.advanceTimersByTime(20);
    tool(4, "update");
    tool(5, "result");
    expect(invocation).toHaveBeenCalledOnce();
    expect(run.readToolMessage("run", "call")?.content).toContainEqual({
      type: "toolresult",
      name: "exec",
      text: "Result 5",
    });
    vi.advanceTimersByTime(100);
    expect(invocation).toHaveBeenCalledOnce();
    expect(state.toolStreamSyncTimer).toBeNull();
  });

  it.each(["all", "run", "run with sibling"])("reschedules after a %s reset", (scope) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    captureAnimationFrames();
    const { state } = createSessionEventState({ chatRunId: "run" });
    const invocation = vi.fn();
    const survivor = scope === "run with sibling";
    const observedRun = survivor ? "sibling" : "run";
    onTestFinished(
      chatRunPresentation(state).subscribeToolMessage(observedRun, "call", invocation),
    );
    const tool = (seq: number) =>
      agentEvent(state, "run", seq, "tool", {
        toolCallId: "call",
        name: "exec",
        phase: "start",
      });
    tool(1);
    if (survivor) {
      agentEvent(state, "sibling", 1, "tool", { toolCallId: "call", name: "exec", phase: "start" });
    }
    vi.advanceTimersByTime(80);
    vi.advanceTimersByTime(20);
    tool(2);
    if (survivor) {
      agentEvent(state, "sibling", 2, "tool", {
        toolCallId: "call",
        name: "exec",
        phase: "update",
        partialResult: "Before reset",
      });
    }
    if (scope === "all") {
      resetToolStream(state);
    } else {
      resetToolStreamRun(state, "run");
    }
    if (survivor) {
      expect(chatRunPresentation(state).readToolMessage("sibling", "call")?.content).toContainEqual(
        { type: "toolresult", name: "exec", text: "Before reset" },
      );
    }
    invocation.mockClear();
    vi.advanceTimersByTime(20);
    agentEvent(state, observedRun, 3, "tool", {
      toolCallId: "call",
      name: "exec",
      phase: "update",
      partialResult: "After reset",
    });
    vi.advanceTimersByTime(survivor ? 59 : 79);
    expect(invocation).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(invocation).toHaveBeenCalledOnce();
  });

  it("publishes a pending run projection when an unrelated pane commit consumes its frame", () => {
    const { frames } = captureAnimationFrames();
    const awaitDomCommit = vi.fn(async () => true);
    const controller = createChatState<ChatPageHost>({
      awaitDomCommit,
    });
    let state: ChatPageHost;
    const rendered: (string | null)[] = [];
    const queueLengths: number[] = [];
    const activityChanged = vi.fn();
    const dispose = createRoot((stop) => {
      state = createPageState(createChatPageStateContext(), controller.createRenderLifecycle(), {
        dispatchEvent: () => true,
      });
      state.client = createTestGatewayClient(vi.fn());
      controller.attach(state);
      state.chatStream = "initial stream";
      onTestFinished(chatRunPresentation(state).subscribeNonText(activityChanged));
      createEffect(
        () => state.chatStream,
        (stream) => {
          rendered.push(stream);
        },
      );
      createEffect(
        () => state.chatQueue.length,
        (length) => {
          queueLengths.push(length);
        },
      );
      return stop;
    });
    onTestFinished(() => {
      controller.dispose();
      dispose();
    });
    flush();
    awaitDomCommit.mockClear();
    chatRunPresentation(state!).batch(
      () => (state!.chatStream = "queued stream"),
      "animation-frame",
    );
    expect(frames.size).toBe(1);
    controller.publishPendingRunState();
    controller.captureRenderChanges();
    flush();
    expect(frames.size).toBe(0);
    expect(activityChanged).not.toHaveBeenCalled();
    expect(rendered).toEqual(["initial stream", "queued stream"]);
    keepVolatileQueuedMessage(state!, state!.sessionKey, {
      id: "run-and-outbox-publication",
      text: "Keep this queued input",
      createdAt: 1,
      sendState: "held",
    });
    expect(state!.chatQueue).toHaveLength(1);
    flush();
    expect(queueLengths).toEqual([0, 1]);
    removeQueuedMessage(state!, "run-and-outbox-publication");
    flush();
    expect(queueLengths).toEqual([0, 1, 0]);
    expect(rendered).toEqual(["initial stream", "queued stream"]);
    expect(awaitDomCommit).not.toHaveBeenCalled();
  });

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
    const invocation = vi.fn();
    const unrelated = vi.fn();
    onTestFinished(run.subscribeToolMessage("run", "growing-tool", invocation));
    onTestFinished(run.subscribeToolMessage("other-run", "growing-tool", unrelated));
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
    agentEvent(state, "run", 1, "tool", {
      toolCallId: "unchanged-tool",
      name: "read",
      phase: "start",
    });
    vi.advanceTimersByTime(80);
    const entry = state.toolStreamById.get(JSON.stringify(["run", "growing-tool"]));
    const initialMessage = state.chatToolMessages[0];
    const unchangedMessage = state.chatToolMessages[1];
    const outputSnapshots = new Set([initialMessage]);
    chatEvent(state, "run", "delta", "Answer 2");
    tool(2, "update");
    paint();
    activity.mockClear();
    text.mockClear();
    invocation.mockClear();

    for (let seq = 3; seq <= 5; seq++) {
      chatEvent(state, "run", "delta", `Answer ${seq}`);
      tool(seq, "update");
      paint();
      expect(state.chatRunStartup).toMatchObject({ state: "activity", seq });
      // Accepted facts advance synchronously; immutable projections belong to the existing flush.
      expect(entry?.output).toBe(`Progress ${seq}`);
      outputSnapshots.add(entry?.message);
    }
    expect(outputSnapshots.size).toBe(1);
    expect(text).toHaveBeenCalledTimes(3);
    expect(activity).not.toHaveBeenCalled();
    expect(state.chatStream).toBe("Answer 5");
    vi.advanceTimersByTime(80);
    expect(activity).not.toHaveBeenCalled();
    expect(invocation).toHaveBeenCalledOnce();
    expect(unrelated).not.toHaveBeenCalled();
    expect(run.readToolMessage("run", "growing-tool")).toBe(state.chatToolMessages[0]);
    expect(state.chatToolMessages[0]?.content).toContainEqual({
      type: "toolresult",
      name: "read",
      text: "Progress 5",
    });
    expect(state.chatToolMessages[0]).not.toBe(initialMessage);
    outputSnapshots.add(state.chatToolMessages[0]);
    expect(outputSnapshots.size).toBe(2);
    expect(state.chatToolMessages[1]).toBe(unchangedMessage);

    text.mockClear();
    invocation.mockClear();
    for (let seq = 6; seq <= 9; seq++) {
      tool(seq, "update");
      expect(state.chatRunStartup).toMatchObject({ state: "activity", seq });
      // The accepted sequence advances now; output still belongs to its existing timer.
      expect(frames.size).toBe(0);
    }
    expect(text).not.toHaveBeenCalled();
    expect(invocation).not.toHaveBeenCalled();
    vi.advanceTimersByTime(80);
    expect(invocation).toHaveBeenCalledOnce();
    expect(state.chatToolMessages[0]?.content).toContainEqual({
      type: "toolresult",
      name: "read",
      text: "Progress 9",
    });
  });

  it("preserves explicit retained-object publications alongside narrow invocation changes", () => {
    const host = {
      chatToolMessages: [] as Record<string, unknown>[],
      waitingApprovalStatuses: new Map(),
    };
    const run = chatRunPresentation(host);
    const activity = vi.fn();
    const invocation = vi.fn();
    onTestFinished(run.subscribeNonText(activity));
    onTestFinished(run.subscribeToolMessage("run", "call", invocation));
    run.batch(() => {
      run.publishToolMessages([{ runId: "run", toolCallId: "call" }], false, [
        buildToolStreamIdentity("run", "call"),
      ]);
      host.waitingApprovalStatuses.set("approval", { runId: "run" });
      run.publish();
    });
    expect(activity).toHaveBeenCalledOnce();
    expect(invocation).toHaveBeenCalledOnce();
    expect(host.waitingApprovalStatuses.has("approval")).toBe(true);

    invocation.mockClear();
    host.chatToolMessages = [];
    expect(invocation).toHaveBeenCalledOnce();
    expect(run.readToolMessage("run", "call")).toBeUndefined();
    const replacement = { runId: "run", toolCallId: "call", content: "Replacement" };
    host.chatToolMessages = [replacement];
    expect(invocation).toHaveBeenCalledTimes(2);
    expect(run.readToolMessage("run", "call")).toBe(replacement);
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
