/* @vitest-environment jsdom */
import { createEffect, createRoot, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { createTestChatPane, getPaneTestRuntime } from "./chat-pane.test-support.ts";
import { applyChatPendingInputs } from "./chat-pending-inputs.ts";
import { chatRunPresentation } from "./chat-run-presentation.ts";
import { handlePageGatewayEvent } from "./chat-state-events.test-support.ts";
import { createComposerQuestions } from "./components/chat-composer-questions.ts";
import {
  canAutoFollowChat,
  handleChatScrollTakeover,
  scheduleCommittedChatScroll,
} from "./scroll.ts";

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
function userMessage(sendId: string) {
  return {
    role: "user",
    content: sendId,
    __openclaw: {
      id: sendId,
      idempotencyKey: sendId + ":user",
      senderId: "same-profile",
      senderIdentity: { type: "profile", id: "same-profile" },
    },
  };
}
function setup() {
  const { pane, state } = createTestChatPane({ client: createTestGatewayClient(async () => ({})) });
  const runtime = getPaneTestRuntime(pane);
  const controller = runtime.chatState;
  const dispose = controller.dispose;
  disposals.push(dispose);
  state.sessionKey = "agent:main:scroll-ownership";
  state.currentSessionId = "physical-session";
  state.chatMessages = [userMessage("loaded")];
  state.chatHasAutoScrolled = true;
  state.chatUserNearBottom = true;
  state.selfUser = {
    id: "same-profile",
    name: "Reader",
    identity: { type: "profile", id: "same-profile" },
  };
  const scrollport = document.createElement("div");
  let height = 2000;
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
  return {
    state,
    runtime,
    controller,
    dispose,
    published,
    scrollport,
    commitGrowth: () => {
      height += 889;
      controller.publishPendingRunState();
      controller.captureRenderChanges();
      controller.commitRender();
      vi.advanceTimersToNextFrame();
    },
  };
}

describe("transcript arrival scroll ownership", () => {
  it("publishes stream arrival and removal to the pane without publishing continuing text", () => {
    const { state } = setup();
    const paneUpdate = vi.fn();
    disposals.push(chatRunPresentation(state).subscribeNonText(paneUpdate));
    const publish = (text: string | null) => {
      chatRunPresentation(state).batch(() => {
        state.chatStream = text;
      }, "animation-frame");
      vi.advanceTimersToNextFrame();
    };

    publish("First text");
    expect(paneUpdate).toHaveBeenCalledOnce();
    paneUpdate.mockClear();
    publish("First text continues");
    expect(paneUpdate).not.toHaveBeenCalled();
    publish(null);
    expect(paneUpdate).toHaveBeenCalledOnce();
  });

  it("keeps a pending manual command ahead of geometric follow", () => {
    const source = "manual";
    const { state } = setup();
    const follow = vi.spyOn(state, "chatScrollToEnd");
    state.chatHasAutoScrolled = false;
    state.chatFollowLocked = false;
    scheduleCommittedChatScroll(state, true, false, { source });

    expect(canAutoFollowChat(state)).toBe(false);
    expect(follow).not.toHaveBeenCalled();
    vi.advanceTimersToNextFrame();
    expect(follow).toHaveBeenCalledExactlyOnceWith({ behavior: "auto", source });
    expect(state.chatHasAutoScrolled).toBe(true);
  });

  it("keeps text publications out of the message and run-state projections", () => {
    const { state, runtime } = setup();
    state.chatRunId = "stream-run";
    const props = runtime.render().layout?.primary.chat;
    if (!props) {
      throw new Error("Expected a chat pane");
    }
    const observed = vi.fn();
    disposals.push(
      createRoot((dispose) => {
        const questions = createComposerQuestions(props.paneId, () => props);
        createEffect(
          () => ({
            messages: state.chatMessages,
            runId: state.chatRunId,
            questions: questions.source(),
          }),
          observed,
        );
        return dispose;
      }),
    );
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
    observed.mockClear();
    for (const seq of [2, 3, 4]) {
      delta(seq);
    }
    expect(state.chatStream).toBe("Reply 4");
    vi.advanceTimersToNextFrame();
    flush();
    expect(observed).not.toHaveBeenCalled();
    chatRunPresentation(state).batch(() => {
      state.chatStream = null;
      state.chatRunId = null;
    });
    flush();
    expect(observed).toHaveBeenCalledOnce();
    expect(observed.mock.calls[0]?.[0].runId).toBeNull();
  });

  it("only schedules same-height streaming arrivals for a locked reader without a pane commit", async () => {
    const { state, scrollport } = setup();
    const follow = vi.spyOn(state, "chatScrollToEnd");
    chatRunPresentation(state).batch(() => {
      state.chatStream = "Text in the existing tail row";
    }, "animation-frame");
    vi.advanceTimersToNextFrame();
    await Promise.resolve();
    vi.advanceTimersToNextFrame();
    expect(follow).not.toHaveBeenCalled();
    expect(scrollport.scrollTop).toBe(1500);
    expect(state.chatNewMessagesBelow).toBe(false);
    scrollport.scrollTop = 800;
    handleChatScrollTakeover(state);
    state.chatNewMessagesBelow = false;
    chatRunPresentation(state).batch(() => {
      state.chatStream = "More text in the existing tail row";
    }, "animation-frame");
    vi.advanceTimersToNextFrame();
    await Promise.resolve();
    vi.advanceTimersToNextFrame();
    expect(state.chatNewMessagesBelow).toBe(true);
    expect(scrollport.scrollTop).toBe(800);
    expect(follow).not.toHaveBeenCalled();
  });

  it("coalesces streamed replies without delaying the draft or new transcript rows", () => {
    const { state, controller, published } = setup();
    for (let index = 0; index < 36; index++) {
      chatRunPresentation(state).batch(() => {
        state.chatStream = `Reply ${index}`;
      }, "animation-frame");
    }
    expect(published).not.toHaveBeenCalled();
    vi.advanceTimersToNextFrame();
    expect(published).toHaveBeenCalledOnce();
    expect(state.chatStream).toBe("Reply 35");

    chatRunPresentation(state).batch(() => {
      state.chatStream = "A queued reply";
    }, "animation-frame");
    state.handleChatDraftChange("Keep this draft");
    expect(controller.composerDraft.read().draft).toBe("Keep this draft");
    expect(published).toHaveBeenCalledOnce();
    vi.advanceTimersToNextFrame();
    expect(published).toHaveBeenCalledTimes(2);

    chatRunPresentation(state).publish("animation-frame");
    state.chatMessages = [...state.chatMessages, userMessage("remote")];
    expect(published).toHaveBeenCalledTimes(3);
    vi.advanceTimersToNextFrame();
    expect(published).toHaveBeenCalledTimes(3);
  });

  it("absorbs a pending stream publication into a commit and cancels on teardown", async () => {
    const { controller, dispose, published, state } = setup();
    chatRunPresentation(state).batch(() => {
      state.chatStream = "Waiting for a frame";
    }, "animation-frame");
    controller.publishPendingRunState();
    controller.captureRenderChanges();
    vi.advanceTimersToNextFrame();
    expect(published).toHaveBeenCalledOnce();

    const effect = vi.fn();
    state.renderLifecycle.afterCommit(effect);
    await Promise.resolve();
    expect(effect).toHaveBeenCalledOnce();
    chatRunPresentation(state).batch(() => {
      state.chatStream = "Retired before publication";
    }, "animation-frame");
    dispose();
    const publicationsAtDisposal = published.mock.calls.length;
    vi.advanceTimersToNextFrame();
    expect(published).toHaveBeenCalledTimes(publicationsAtDisposal);
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
    const { controller, state, scrollport } = setup();
    const follow = vi.spyOn(state, "chatScrollToEnd");
    const readHeight = vi.spyOn(scrollport, "scrollHeight", "get");
    const commit = () => {
      controller.captureRenderChanges();
      controller.commitRender();
      vi.advanceTimersToNextFrame();
    };
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

  it.each(["message", "pending input", "resumed stream", "speech"] as const)(
    "follows remote %s growth only while the viewer is following",
    (source) => {
      for (const mode of ["end", "near end", "reading"] as const) {
        const { state, scrollport, commitGrowth } = setup();
        if (mode !== "end") {
          scrollport.scrollTop -= 80;
          if (mode === "reading") {
            handleChatScrollTakeover(state);
          }
        }
        const before = scrollport.scrollTop;
        if (source === "pending input") {
          applyChatPendingInputs(state, {
            items: [
              {
                id: "remote",
                runId: "remote",
                acceptedAt: 1,
                state: "queued",
                message: userMessage("remote"),
              },
            ],
            total: 1,
          });
        } else if (source === "resumed stream") {
          state.chatStream = "A response started outside this tab.";
        } else {
          state.chatMessages = [
            ...state.chatMessages,
            userMessage(source === "speech" ? "voice:other-call:1" : "remote"),
          ];
        }
        commitGrowth();
        expect(scrollport.scrollTop, `${source}: ${mode}`).toBe(mode === "reading" ? before : 2389);
        expect(state.chatNewMessagesBelow).toBe(mode === "reading");

        // Promotion and a growing reply must retain the same reader policy.
        applyChatPendingInputs(state, { items: [], total: 0 });
        state.chatMessages = [...state.chatMessages, userMessage("remote")];
        state.chatStream = "The response continues after the input is saved.";
        commitGrowth();
        expect(scrollport.scrollTop, `${source} continuation: ${mode}`).toBe(
          mode === "reading" ? before : 3278,
        );
      }
    },
  );
});
