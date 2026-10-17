/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { createInitializationContext } from "./chat-pane.test-support.ts";
import { applyChatPendingInputs } from "./chat-pending-inputs.ts";
import { createChatState } from "./chat-state-controller.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createPageState } from "./chat-state-page.ts";
import { publishChatRunState } from "./chat-state-render.ts";
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
  const requestUpdate = vi.fn();
  const controller = createChatState<ChatPageHost>({
    invalidate: requestUpdate,
    updateComplete: Promise.resolve(true),
  });
  const dispose = controller.dispose;
  disposals.push(dispose);
  const state = createPageState(createInitializationContext(), controller.createRenderLifecycle(), {
    dispatchEvent: () => true,
    querySelector: () => null,
  });
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
    scrollHeight: { get: () => height },
  });
  scrollport.scrollTop = 1500;
  state.chatLastScrollTop = scrollport.scrollTop;
  state.chatScrollElement = () => scrollport;
  state.chatScrollToEnd = () => {
    scrollport.scrollTop = height - scrollport.clientHeight;
    return true;
  };
  controller.attach(state);
  return {
    state,
    controller,
    dispose,
    requestUpdate,
    scrollport,
    commitGrowth: () => {
      state.requestUpdate?.();
      height += 889;
      controller.commitRender();
      vi.advanceTimersToNextFrame();
    },
  };
}

describe("transcript arrival scroll ownership", () => {
  it("coalesces background replies without delaying input or transcript invalidation", () => {
    const { state, controller, requestUpdate } = setup();
    for (let index = 0; index < 36; index++) {
      state.assistantName = `Assistant ${index}`;
      controller.requestBackgroundUpdate();
    }
    expect(requestUpdate).not.toHaveBeenCalled();
    vi.advanceTimersToNextFrame();
    expect(requestUpdate).toHaveBeenCalledTimes(1);

    controller.requestBackgroundUpdate();
    state.chatMessage = "Keep this draft";
    state.requestUpdate?.();
    expect(requestUpdate).toHaveBeenCalledTimes(2);
    vi.advanceTimersToNextFrame();
    expect(requestUpdate).toHaveBeenCalledTimes(2);

    state.chatMessages = [...state.chatMessages, userMessage("remote")];
    controller.requestBackgroundUpdate();
    expect(requestUpdate).toHaveBeenCalledTimes(3);
  });

  it("absorbs a pending background repaint into an immediate commit and cancels on teardown", async () => {
    const { controller, dispose, requestUpdate, state } = setup();
    controller.requestBackgroundUpdate();
    controller.prepareRender();
    vi.advanceTimersToNextFrame();
    expect(requestUpdate).not.toHaveBeenCalled();

    controller.requestBackgroundUpdate();
    const effect = vi.fn();
    state.renderLifecycle.afterCommit(effect);
    expect(requestUpdate).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(effect).toHaveBeenCalledOnce();
    controller.requestBackgroundUpdate();
    dispose();
    vi.advanceTimersToNextFrame();
    expect(requestUpdate).toHaveBeenCalledOnce();
  });

  it("preserves follow effects when a host commit consumes a queued stream frame", () => {
    const { controller, requestUpdate, state } = setup();
    const follow = vi.spyOn(state, "chatScrollToEnd");
    state.chatStream = "A response arrived before the property commit.";
    publishChatRunState(state, "animation-frame");
    controller.prepareRender();
    controller.commitRender();
    vi.advanceTimersToNextFrame();
    expect(requestUpdate).not.toHaveBeenCalled();
    expect(follow).toHaveBeenCalledOnce();
    expect(state.chatStreamRenderFrame).toBeNull();
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
