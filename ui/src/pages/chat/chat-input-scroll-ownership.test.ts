/* @vitest-environment jsdom */
import { createEffect, createRoot, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { createTestChatPane, getPaneTestRuntime } from "./chat-pane.test-support.ts";
import { chatRunPresentation } from "./chat-run-presentation.ts";
import { handlePageGatewayEvent } from "./chat-state-events.test-support.ts";
import { createComposerQuestions } from "./components/chat-composer-questions.ts";
import { handleChatScrollTakeover } from "./scroll.ts";

const disposals: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("localStorage", createStorageMock());
});
afterEach(() => {
  for (const dispose of disposals.splice(0)) {
    dispose();
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function setup() {
  const { pane, state } = createTestChatPane({ client: createTestGatewayClient(async () => ({})) });
  const runtime = getPaneTestRuntime(pane);
  const controller = runtime.chatState;
  const dispose = controller.dispose;
  disposals.push(dispose);
  state.sessionKey = "agent:main:scroll-ownership";
  state.currentSessionId = "physical-session";
  state.chatMessages = [{ role: "user", content: "loaded" }];
  state.chatHasAutoScrolled = true;
  state.chatUserNearBottom = true;
  const scrollport = document.createElement("div");
  const height = 2000;
  Object.defineProperties(scrollport, {
    clientHeight: { value: 500 },
    scrollHeight: { configurable: true, get: () => height },
  });
  scrollport.scrollTop = 1500;
  state.chatLastScrollTop = scrollport.scrollTop;
  state.chatScrollElement = () => scrollport;
  state.chatScrollToEnd = () => {
    scrollport.scrollTop = height - scrollport.clientHeight;
    return true;
  };
  controller.publishPendingRunState();
  controller.captureRenderChanges();
  controller.commitRender();
  vi.advanceTimersToNextFrame();
  const published = vi.fn();
  disposals.push(chatRunPresentation(state).subscribe(published));
  const commit = () => {
    controller.captureRenderChanges();
    controller.commitRender();
    vi.advanceTimersToNextFrame();
  };
  return {
    state,
    runtime,
    controller,
    dispose,
    published,
    scrollport,
    commit,
    stream: (text: string | null) => {
      chatRunPresentation(state).batch(() => {
        state.chatStream = text;
      }, "animation-frame");
    },
  };
}

describe("transcript arrival scroll ownership", () => {
  it("keeps text publications out of the message and run-state projections", () => {
    const { state, runtime, stream, dispose, published } = setup();
    state.chatRunId = "stream-run";
    const props = runtime.render().layout?.primary.chat;
    if (!props) {
      throw new Error("Expected a chat pane");
    }
    const observed = vi.fn();
    disposals.push(
      createRoot((stop) => {
        const questions = createComposerQuestions(props.paneId, () => props);
        createEffect(
          () => ({
            messages: state.chatMessages,
            runId: state.chatRunId,
            questions: questions.source(),
          }),
          observed,
        );
        return stop;
      }),
    );
    flush();
    observed.mockClear();
    const delta = (seq: number) =>
      handlePageGatewayEvent(state, {
        type: "event",
        event: "chat",
        payload: {
          state: "delta",
          sessionKey: state.sessionKey,
          runId: "stream-run",
          seq,
          message: { role: "assistant", content: [{ type: "text", text: `Reply ${seq}` }] },
        },
      });
    delta(1);
    vi.advanceTimersToNextFrame();
    flush();
    expect(observed).toHaveBeenCalledOnce();
    observed.mockClear();
    for (const seq of [2, 3, 4]) {
      delta(seq);
    }
    expect(state.chatStream).toBe("Reply 4");
    vi.advanceTimersToNextFrame();
    flush();
    expect(observed).not.toHaveBeenCalled();
    state.chatStream = null;
    flush();
    expect(observed).toHaveBeenCalledOnce();
    state.chatRunId = null;
    flush();
    expect(observed).toHaveBeenCalledTimes(2);
    expect(observed.mock.calls[1]?.[0].runId).toBeNull();
    stream("Retired before publication");
    dispose();
    const publicationsAtDisposal = published.mock.calls.length;
    vi.advanceTimersToNextFrame();
    expect(published).toHaveBeenCalledTimes(publicationsAtDisposal);
  });

  it("only schedules same-height streaming arrivals for a locked reader without a pane commit", async () => {
    const { state, scrollport, stream } = setup();
    const follow = vi.spyOn(state, "chatScrollToEnd");
    stream("Text in the existing tail row");
    vi.advanceTimersToNextFrame();
    await Promise.resolve();
    vi.advanceTimersToNextFrame();
    expect(follow).not.toHaveBeenCalled();
    expect(scrollport.scrollTop).toBe(1500);
    expect(state.chatNewMessagesBelow).toBe(false);
    scrollport.scrollTop = 800;
    handleChatScrollTakeover(state);
    state.chatNewMessagesBelow = false;
    stream("More text in the existing tail row");
    vi.advanceTimersToNextFrame();
    await Promise.resolve();
    vi.advanceTimersToNextFrame();
    expect(state.chatNewMessagesBelow).toBe(true);
    expect(scrollport.scrollTop).toBe(800);
    expect(follow).not.toHaveBeenCalled();
  });

  it("preserves follow effects when a host commit consumes a queued stream frame", () => {
    const { controller, state } = setup();
    const follow = vi.spyOn(state, "chatScrollToEnd");
    state.chatStream = "A response arrived before the property commit.";
    chatRunPresentation(state).publish("animation-frame");
    controller.publishPendingRunState();
    controller.captureRenderChanges();
    controller.commitRender();
    vi.advanceTimersToNextFrame();
    expect(follow).toHaveBeenCalledOnce();
    expect(state.chatStreamRenderFrame).toBeNull();
  });

  it("leaves continuing text to measured row growth without reading the viewport", () => {
    const { state, scrollport, commit } = setup();
    const follow = vi.spyOn(state, "chatScrollToEnd");
    const readHeight = vi.spyOn(scrollport, "scrollHeight", "get");
    state.chatStream = "First text";
    commit();
    expect(follow).toHaveBeenCalledOnce();
    follow.mockClear();
    readHeight.mockClear();

    for (const text of ["First text grows", "First text grows again", "First text grows again."]) {
      state.chatStream = text;
      commit();
    }
    expect(follow).not.toHaveBeenCalled();
    expect(readHeight).not.toHaveBeenCalled();
    expect(state.chatNewMessagesBelow).toBe(false);

    scrollport.scrollTop = 800;
    handleChatScrollTakeover(state);
    state.chatNewMessagesBelow = false;
    readHeight.mockClear();
    state.chatStream = "Text also arrives while reading history";
    commit();
    expect(follow).not.toHaveBeenCalled();
    expect(readHeight).not.toHaveBeenCalled();
    expect(state.chatNewMessagesBelow).toBe(true);
    expect(scrollport.scrollTop).toBe(800);

    scrollport.scrollTop = 1500;
    state.chatFollowLocked = false;
    state.chatStream = null;
    commit();
    expect(follow).toHaveBeenCalledOnce();
  });
});
