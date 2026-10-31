/* @vitest-environment jsdom */
import type { ReactiveControllerHost } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  beginHistoryRequest,
  chatHistoryRequests,
  recordInitialChatInputHistory,
  takeInitialChatInputHistory,
  resetChatHistoryProjection,
} from "./chat-history-state.ts";
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
  it("admits initial authoritative history after a cached preview without treating it as remote input", () => {
    const state = setup([userMessage("cached")]);
    const requests = chatHistoryRequests(state);
    requests.historyLoad = {
      phase: "pending-connection",
      sessionKey: state.sessionKey,
      requestAgentId: undefined,
      startup: true,
    };
    const accepted = {
      phase: "committed" as const,
      client: state.client!,
      sessions: state.sessions,
      connectionEpoch: state.connectionEpoch,
      sessionKey: state.sessionKey,
      requestAgentId: undefined,
      sessionId: state.currentSessionId,
      sessionInfo: undefined,
    };
    state.connected = true;
    const ownership = beginHistoryRequest(
      state,
      state.client!,
      state.connectionEpoch,
      state.sessionKey,
    );
    recordInitialChatInputHistory(state, ownership, [
      userMessage("cached"),
      userMessage("historical"),
    ]);
    state.chatMessages = [userMessage("cached"), userMessage("historical")];
    state.requestUpdate?.();
    expect(state.chatFollowLocked).toBe(false);
    requests.acceptedHistory = accepted;
    recordInitialChatInputHistory(state, ownership, [userMessage("live-remote")]);
    state.chatMessages = [...state.chatMessages, userMessage("live-remote")];
    state.requestUpdate?.();
    expect(state.chatFollowLocked).toBe(true);
  });
  it("baselines historical pending custody but locks a later live pending input", () => {
    const state = setup([userMessage("cached")]);
    state.connected = true;
    const ownership = beginHistoryRequest(
      state,
      state.client!,
      state.connectionEpoch,
      state.sessionKey,
    );
    recordInitialChatInputHistory(state, ownership, [], {
      pendingInputs: {
        items: [
          {
            id: "pending:old",
            runId: "old",
            acceptedAt: 1,
            state: "queued",
            message: { role: "user", content: "old" },
          },
        ],
        total: 1,
      },
    });
    pending(state, "old");
    expect(state.chatFollowLocked).toBe(false);
    pending(state, "new-live");
    expect(state.chatFollowLocked).toBe(true);
  });
  it("baselines initial delta envelopes using their authoritative send identity", () => {
    const state = setup();
    state.connected = true;
    const ownership = beginHistoryRequest(
      state,
      state.client!,
      state.connectionEpoch,
      state.sessionKey,
    );
    recordInitialChatInputHistory(
      state,
      ownership,
      [
        {
          message: { role: "user", content: "old" },
          messageId: "old-entry",
          clientRunId: "old-send",
        },
      ],
      { payloads: true },
    );
    state.chatMessages = [userMessage("old-send", "old-entry")];
    state.requestUpdate?.();
    expect(state.chatFollowLocked).toBe(false);
    expect(takeInitialChatInputHistory(state)).toBeUndefined();
  });
  it.each(["superseded", "reset"] as const)(
    "retires an initial input receipt when its owner is %s",
    (change) => {
      const state = setup();
      state.connected = true;
      const ownership = beginHistoryRequest(
        state,
        state.client!,
        state.connectionEpoch,
        state.sessionKey,
      );
      recordInitialChatInputHistory(state, ownership, [userMessage("old")]);
      if (change === "reset") {
        resetChatHistoryProjection(state);
      } else {
        beginHistoryRequest(state, state.client!, state.connectionEpoch, state.sessionKey);
      }
      expect(takeInitialChatInputHistory(state)).toBeUndefined();
      expect(chatHistoryRequests(state).initialInputHistory).toBeUndefined();
    },
  );
  it.each(["persisted", "pending"] as const)(
    "preserves %s live-input takeover while initial history is pending",
    (kind) => {
      const state = setup([userMessage("cached")]);
      chatHistoryRequests(state).historyLoad = {
        phase: "pending-connection",
        sessionKey: state.sessionKey,
        requestAgentId: undefined,
        startup: true,
      };
      if (kind === "pending") {
        pending(state, "live-remote");
      } else {
        state.chatMessages = [...state.chatMessages, userMessage("live-remote")];
        state.requestUpdate?.();
      }
      expect(state.chatFollowLocked).toBe(true);
    },
  );
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
