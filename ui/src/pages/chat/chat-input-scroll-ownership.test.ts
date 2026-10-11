/* @vitest-environment jsdom */
import type { ReactiveControllerHost } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { createInitializationContext } from "./chat-pane.test-support.ts";
import { applyChatPendingInputs } from "./chat-pending-inputs.ts";
import { ChatStateController } from "./chat-state-controller.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createPageState } from "./chat-state-page.ts";
import { handleChatScrollTakeover } from "./scroll.ts";

const controllers: ChatStateController<ChatPageHost>[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("localStorage", createStorageMock());
});
afterEach(() => {
  for (const controller of controllers.splice(0)) {
    controller.hostDisconnected();
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
  const host: ReactiveControllerHost = {
    addController: () => undefined,
    removeController: () => undefined,
    requestUpdate: vi.fn(),
    updateComplete: Promise.resolve(true),
  };
  const controller = new ChatStateController<ChatPageHost>(host);
  controllers.push(controller);
  controller.hostConnected();
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
    scrollport,
    commitGrowth: () => {
      state.requestUpdate?.();
      height += 889;
      controller.hostUpdated();
      vi.advanceTimersToNextFrame();
    },
  };
}

describe("transcript arrival scroll ownership", () => {
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
