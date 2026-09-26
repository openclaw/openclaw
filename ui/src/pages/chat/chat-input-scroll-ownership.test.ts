/* @vitest-environment jsdom */
import type { ReactiveControllerHost } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { createInitializationContext } from "./chat-pane.test-support.ts";
import { applyChatPendingInputs } from "./chat-pending-inputs.ts";
import { ChatStateController } from "./chat-state-controller.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createPageState } from "./chat-state-page.ts";

const controllers: ChatStateController<ChatPageHost>[] = [];
beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("localStorage", createStorageMock());
});
afterEach(() => {
  for (const controller of controllers.splice(0)) {
    controller.hostDisconnected();
  }
  vi.unstubAllGlobals();
});
function userMessage(sendId: string, id = sendId, runId = sendId) {
  return {
    role: "user",
    content: sendId,
    __openclaw: {
      id,
      idempotencyKey: sendId + ":user",
      runId,
      senderId: "same-profile",
      senderIdentity: { type: "profile", id: "same-profile" },
    },
  };
}
function setup(messages: unknown[] = []) {
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
  state.chatMessages = messages;
  state.chatHasAutoScrolled = true;
  state.chatUserNearBottom = true;
  state.selfUser = {
    id: "same-profile",
    name: "Reader",
    identity: { type: "profile", id: "same-profile" },
  };
  controller.attach(state);
  return state;
}
function pending(state: ChatPageHost, sendId: string) {
  applyChatPendingInputs(state, {
    items: [
      {
        id: "pending:" + sendId,
        runId: sendId,
        acceptedAt: 1,
        state: "queued",
        message: { role: "user", content: sendId, __openclaw: { id: "pending:" + sendId } },
      },
    ],
    total: 1,
  });
}

describe("sender-local scroll intent", () => {
  it("does not treat already loaded history as a fresh input", () => {
    const state = setup([userMessage("loaded")]);
    state.requestUpdate?.();
    expect(state.chatFollowLocked).toBe(false);
  });
  it("pauses following before a newly accepted remote input renders", () => {
    const state = setup();
    pending(state, "remote");
    expect(state.chatFollowLocked).toBe(true);
    expect(state.chatUserNearBottom).toBe(false);
  });
  it("keeps following when this browser's spoken input is persisted", () => {
    const state = setup();
    state.realtimeTalkConversation = [
      {
        id: "rt-1",
        role: "user",
        text: "Local speech",
        isStreaming: false,
        transcriptId: "voice:local-call:1",
      },
    ];
    state.chatMessages = [userMessage("voice-local", "voice:local-call:1")];
    state.requestUpdate?.();
    expect(state.chatFollowLocked).toBe(false);
    expect(state.chatUserNearBottom).toBe(true);
    state.chatMessages = [...state.chatMessages, userMessage("voice-remote", "voice:other-call:1")];
    state.requestUpdate?.();
    expect(state.chatFollowLocked).toBe(true);
  });
  it("does not infer local intent from the same authenticated sender profile", () => {
    const state = setup();
    state.chatMessages = [userMessage("another-browser")];
    state.requestUpdate?.();
    expect(state.chatFollowLocked).toBe(true);
  });
  it("keeps local submit follow through acceptance and canonical reconciliation", () => {
    const state = setup();
    state.chatQueue = [
      { id: "local-queue", text: "own", createdAt: 1, sendRunId: "own", sendState: "sending" },
    ];
    state.requestUpdate?.();
    pending(state, "own");
    state.chatQueue = [];
    state.chatMessages = [userMessage("own", "canonical-own", "execution-own")];
    state.requestUpdate?.();
    expect(state.chatFollowLocked).toBe(false);
  });
  it("does not pause again when an acknowledged remote input persists after a local return", () => {
    const state = setup();
    pending(state, "remote");
    expect(state.chatFollowLocked).toBe(true);
    // Policy after an explicit local return; custody retirement is not a new input.
    state.chatFollowLocked = false;
    state.chatUserNearBottom = true;
    applyChatPendingInputs(state, { items: [], total: 0 });
    state.chatMessages = [userMessage("remote", "canonical-remote", "execution-remote")];
    state.requestUpdate?.();
    expect(state.chatFollowLocked).toBe(false);
    state.chatMessages = [userMessage("remote", "canonical-remote", "execution-remote")];
    state.requestUpdate?.();
    expect(state.chatFollowLocked).toBe(false);
  });
  it("does not pause initial loading or a different physical conversation", () => {
    const state = setup();
    state.chatHasAutoScrolled = false;
    state.chatMessages = [userMessage("initial")];
    state.requestUpdate?.();
    expect(state.chatFollowLocked).toBe(false);
    state.chatHasAutoScrolled = true;
    state.currentSessionId = "replacement-session";
    state.chatMessages = [userMessage("existing-in-replacement")];
    state.requestUpdate?.();
    expect(state.chatFollowLocked).toBe(false);
  });
  it("does not pause on assistant stream growth alone", () => {
    const state = setup();
    state.chatStream = "The locally requested response continues.";
    state.requestUpdate?.();
    expect(state.chatFollowLocked).toBe(false);
  });
});
