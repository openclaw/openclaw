import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { RealtimeTalkOptions } from "./components/chat-realtime-controls.ts";
import {
  createRealtimeTalkConversationState,
  updateRealtimeTalkConversation,
  type RealtimeTalkConversationEntry,
  type RealtimeTalkConversationState,
} from "./realtime-talk-conversation.ts";
import {
  RealtimeTalkSession,
  type RealtimeTalkLaunchOptions,
  type RealtimeTalkStatus,
} from "./realtime-talk.ts";

export type ChatRealtimeState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  lastError?: string | null;
  chatError?: string | null;
  realtimeTalkActive: boolean;
  realtimeTalkStatus: RealtimeTalkStatus;
  realtimeTalkDetail: string | null;
  realtimeTalkTranscript: string | null;
  realtimeTalkConversation: RealtimeTalkConversationEntry[];
  realtimeTalkOptionsOpen: boolean;
  realtimeTalkOptions: RealtimeTalkOptions;
  realtimeTalkSession: RealtimeTalkSession | null;
  realtimeTalkConversationState: RealtimeTalkConversationState;
  requestUpdate: () => void;
  updateRealtimeTalkOptions: (next: Partial<RealtimeTalkOptions>) => void;
  resetRealtimeTalkConversation: () => void;
  toggleRealtimeTalk: () => Promise<void>;
};

export function createDefaultRealtimeTalkOptions(): RealtimeTalkOptions {
  return {
    model: "",
    voice: "",
    vadThreshold: "",
  };
}

export function createInitialChatRealtimeState() {
  return {
    realtimeTalkActive: false,
    realtimeTalkStatus: "idle" as RealtimeTalkStatus,
    realtimeTalkDetail: null,
    realtimeTalkTranscript: null,
    realtimeTalkConversation: [],
    realtimeTalkOptionsOpen: false,
    realtimeTalkOptions: createDefaultRealtimeTalkOptions(),
    realtimeTalkSession: null,
    realtimeTalkConversationState: createRealtimeTalkConversationState(),
  };
}

export function resetChatRealtimeConversation(state: ChatRealtimeState) {
  state.realtimeTalkConversationState = createRealtimeTalkConversationState();
  state.realtimeTalkConversation = [];
}

export function dismissRealtimeTalkError(state: ChatRealtimeState) {
  if (state.realtimeTalkStatus !== "error") {
    return;
  }
  state.realtimeTalkSession?.stop();
  state.realtimeTalkSession = null;
  state.realtimeTalkActive = false;
  state.realtimeTalkStatus = "idle";
  state.realtimeTalkDetail = null;
  state.realtimeTalkTranscript = null;
  state.resetRealtimeTalkConversation();
}

export function attachChatRealtimeActions(state: ChatRealtimeState) {
  state.resetRealtimeTalkConversation = () => {
    resetChatRealtimeConversation(state);
  };
  state.updateRealtimeTalkOptions = (next) => {
    state.realtimeTalkOptions = { ...state.realtimeTalkOptions, ...next };
    state.requestUpdate();
  };
  state.toggleRealtimeTalk = async () => {
    if (state.realtimeTalkSession) {
      state.realtimeTalkSession.stop();
      state.realtimeTalkSession = null;
      state.realtimeTalkActive = false;
      state.realtimeTalkStatus = "idle";
      state.realtimeTalkDetail = null;
      state.resetRealtimeTalkConversation();
      state.requestUpdate();
      return;
    }
    if (!state.client || !state.connected) {
      state.lastError = "Gateway not connected";
      state.chatError = state.lastError;
      state.requestUpdate();
      return;
    }
    const options = state.realtimeTalkOptions;
    const launchOptions: RealtimeTalkLaunchOptions = {
      model: options.model.trim() || undefined,
      voice: options.voice.trim() || undefined,
      vadThreshold: Number(options.vadThreshold) || undefined,
    };
    state.realtimeTalkActive = true;
    state.realtimeTalkStatus = "connecting";
    state.realtimeTalkDetail = null;
    state.resetRealtimeTalkConversation();
    const session = new RealtimeTalkSession(
      state.client,
      state.sessionKey,
      {
        onStatus: (status, detail) => {
          state.realtimeTalkStatus = status;
          state.realtimeTalkDetail = detail ?? null;
          state.realtimeTalkActive = status !== "idle";
          state.requestUpdate();
        },
        onTranscript: (entry) => {
          state.realtimeTalkTranscript = `${entry.role === "user" ? "You" : "OpenClaw"}: ${entry.text}`;
          state.realtimeTalkConversationState = updateRealtimeTalkConversation(
            state.realtimeTalkConversationState,
            entry,
          );
          state.realtimeTalkConversation = state.realtimeTalkConversationState.entries;
          state.requestUpdate();
        },
      },
      launchOptions,
    );
    state.realtimeTalkSession = session;
    try {
      await session.start();
    } catch (error) {
      session.stop();
      state.realtimeTalkSession = null;
      state.realtimeTalkActive = false;
      state.realtimeTalkStatus = "error";
      state.realtimeTalkDetail = error instanceof Error ? error.message : String(error);
      state.requestUpdate();
    }
  };
}
