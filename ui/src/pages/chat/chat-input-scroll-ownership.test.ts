/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { createTestChatPane, getPaneTestRuntime } from "./chat-pane.test-support.ts";
import { applyChatPendingInputs } from "./chat-pending-inputs.ts";
import { chatRunPresentation } from "./chat-run-presentation.ts";
import { mutateChatRunState, publishChatRunState } from "./chat-state-render.ts";
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
  const { pane, state } = createTestChatPane({ client: createTestGatewayClient(async () => ({})) });
  const controller = getPaneTestRuntime(pane).chatState;
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
    scrollHeight: { get: () => height },
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
  it("coalesces streamed replies without delaying the draft or new transcript rows", () => {
    const { state, controller, published } = setup();
    for (let index = 0; index < 36; index++) {
      mutateChatRunState(
        state,
        () => {
          state.chatStream = `Reply ${index}`;
        },
        "animation-frame",
      );
    }
    expect(published).not.toHaveBeenCalled();
    vi.advanceTimersToNextFrame();
    expect(published).toHaveBeenCalledOnce();
    expect(state.chatStream).toBe("Reply 35");

    mutateChatRunState(
      state,
      () => {
        state.chatStream = "A queued reply";
      },
      "animation-frame",
    );
    state.handleChatDraftChange("Keep this draft");
    expect(controller.composerDraft.read().draft).toBe("Keep this draft");
    expect(published).toHaveBeenCalledOnce();
    vi.advanceTimersToNextFrame();
    expect(published).toHaveBeenCalledTimes(2);

    publishChatRunState(state, "animation-frame");
    state.chatMessages = [...state.chatMessages, userMessage("remote")];
    expect(published).toHaveBeenCalledTimes(3);
    vi.advanceTimersToNextFrame();
    expect(published).toHaveBeenCalledTimes(3);
  });

  it("absorbs a pending stream publication into a commit and cancels on teardown", async () => {
    const { controller, dispose, published, state } = setup();
    mutateChatRunState(
      state,
      () => {
        state.chatStream = "Waiting for a frame";
      },
      "animation-frame",
    );
    controller.publishPendingRunState();
    controller.captureRenderChanges();
    vi.advanceTimersToNextFrame();
    expect(published).toHaveBeenCalledOnce();

    const effect = vi.fn();
    state.renderLifecycle.afterCommit(effect);
    await Promise.resolve();
    expect(effect).toHaveBeenCalledOnce();
    mutateChatRunState(
      state,
      () => {
        state.chatStream = "Retired before publication";
      },
      "animation-frame",
    );
    dispose();
    const publicationsAtDisposal = published.mock.calls.length;
    vi.advanceTimersToNextFrame();
    expect(published).toHaveBeenCalledTimes(publicationsAtDisposal);
  });

  it("preserves follow effects when a host commit consumes a queued stream frame", () => {
    const { controller, state } = setup();
    const follow = vi.spyOn(state, "chatScrollToEnd");
    state.chatStream = "A response arrived before the property commit.";
    publishChatRunState(state, "animation-frame");
    controller.publishPendingRunState();
    controller.captureRenderChanges();
    controller.commitRender();
    vi.advanceTimersToNextFrame();
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
