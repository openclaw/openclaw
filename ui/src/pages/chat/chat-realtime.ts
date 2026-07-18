import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { loadSettings, type UiSettings } from "../../app/settings.ts";
import {
  createRealtimeTalkConversationState,
  updateRealtimeTalkConversation,
  type RealtimeTalkConversationEntry,
  type RealtimeTalkConversationState,
} from "./realtime-talk-conversation.ts";
import { RealtimeTalkLevelSignal } from "./realtime-talk-level.ts";
import { RealtimeTalkSession, type RealtimeTalkStatus } from "./realtime-talk.ts";

export type ChatRealtimeState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  settings: UiSettings;
  sessionKey: string;
  lastError?: string | null;
  chatError?: string | null;
  realtimeTalkActive: boolean;
  realtimeTalkStatus: RealtimeTalkStatus;
  realtimeTalkDetail: string | null;
  realtimeTalkInputLevel: RealtimeTalkLevelSignal;
  realtimeTalkConversation: RealtimeTalkConversationEntry[];
  realtimeTalkVideoStream: MediaStream | null;
  realtimeTalkVideoCapable: boolean;
  realtimeTalkVideoPending: boolean;
  realtimeTalkCameraError: boolean;
  realtimeTalkSession: RealtimeTalkSession | null;
  realtimeTalkConversationState: RealtimeTalkConversationState;
  requestUpdate: () => void;
  resetRealtimeTalkConversation: () => void;
  toggleRealtimeTalk: () => Promise<void>;
  toggleRealtimeTalkCamera: () => Promise<void>;
};

export function createInitialChatRealtimeState() {
  return {
    realtimeTalkActive: false,
    realtimeTalkStatus: "idle" as RealtimeTalkStatus,
    realtimeTalkDetail: null,
    realtimeTalkInputLevel: new RealtimeTalkLevelSignal(),
    realtimeTalkConversation: [],
    realtimeTalkVideoStream: null,
    realtimeTalkVideoCapable: false,
    realtimeTalkVideoPending: false,
    realtimeTalkCameraError: false,
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
  state.realtimeTalkInputLevel.set(0);
  state.realtimeTalkVideoStream = null;
  state.realtimeTalkVideoCapable = false;
  state.realtimeTalkVideoPending = false;
  state.realtimeTalkCameraError = false;
  state.resetRealtimeTalkConversation();
}

export function attachChatRealtimeActions(state: ChatRealtimeState) {
  state.resetRealtimeTalkConversation = () => {
    resetChatRealtimeConversation(state);
  };
  state.toggleRealtimeTalk = async () => {
    if (state.realtimeTalkSession) {
      state.realtimeTalkSession.stop();
      state.realtimeTalkSession = null;
      state.realtimeTalkActive = false;
      state.realtimeTalkStatus = "idle";
      state.realtimeTalkDetail = null;
      state.realtimeTalkInputLevel.set(0);
      state.realtimeTalkVideoStream = null;
      state.realtimeTalkVideoCapable = false;
      state.realtimeTalkVideoPending = false;
      state.realtimeTalkCameraError = false;
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
    // Re-read persisted settings so a microphone picked on the Settings page
    // applies to the next talk session without a reload.
    const inputDeviceId = loadSettings().realtimeTalkInputDeviceId?.trim() || undefined;
    state.realtimeTalkActive = true;
    state.realtimeTalkStatus = "connecting";
    state.realtimeTalkDetail = null;
    state.realtimeTalkVideoCapable = false;
    state.realtimeTalkVideoPending = false;
    state.realtimeTalkCameraError = false;
    state.realtimeTalkInputLevel.set(0);
    state.resetRealtimeTalkConversation();
    const session = new RealtimeTalkSession(
      state.client,
      state.sessionKey,
      {
        onStatus: (status, detail) => {
          if (state.realtimeTalkSession !== session) {
            return;
          }
          state.realtimeTalkStatus = status;
          state.realtimeTalkDetail = detail ?? null;
          state.realtimeTalkCameraError = false;
          state.realtimeTalkActive = status !== "idle";
          if (status === "idle" || status === "error") {
            state.realtimeTalkInputLevel.set(0);
          }
          state.requestUpdate();
        },
        onVideoCapability: (capable) => {
          if (state.realtimeTalkSession !== session) {
            return;
          }
          state.realtimeTalkVideoCapable = capable;
          state.requestUpdate();
        },
        onInputLevel: (level) => {
          if (state.realtimeTalkSession !== session) {
            return;
          }
          state.realtimeTalkInputLevel.set(level);
        },
        onTranscript: (entry) => {
          if (state.realtimeTalkSession !== session) {
            return;
          }
          state.realtimeTalkConversationState = updateRealtimeTalkConversation(
            state.realtimeTalkConversationState,
            entry,
          );
          state.realtimeTalkConversation = state.realtimeTalkConversationState.entries;
          state.requestUpdate();
        },
        onVideoStream: (stream) => {
          if (state.realtimeTalkSession !== session) {
            return;
          }
          if (stream && state.realtimeTalkStatus === "error") {
            void session.setVideoEnabled(false).catch(() => undefined);
            return;
          }
          state.realtimeTalkVideoStream = stream;
          if (stream) {
            state.realtimeTalkDetail = null;
            state.realtimeTalkCameraError = false;
          }
          state.requestUpdate();
        },
      },
      {},
      { inputDeviceId },
    );
    state.realtimeTalkSession = session;
    try {
      await session.start();
    } catch (error) {
      if (state.realtimeTalkSession !== session) {
        return;
      }
      session.stop();
      state.realtimeTalkSession = null;
      state.realtimeTalkActive = false;
      state.realtimeTalkStatus = "error";
      state.realtimeTalkDetail = error instanceof Error ? error.message : String(error);
      state.realtimeTalkInputLevel.set(0);
      state.realtimeTalkVideoStream = null;
      state.realtimeTalkVideoCapable = false;
      state.realtimeTalkVideoPending = false;
      state.realtimeTalkCameraError = false;
      state.requestUpdate();
    }
  };
  // Reads through a call so TS does not keep the early-guard narrowing across the
  // await below; the status can legitimately become "error" while acquiring the camera.
  const talkStatusIsError = () => state.realtimeTalkStatus === "error";
  state.toggleRealtimeTalkCamera = async () => {
    const session = state.realtimeTalkSession;
    if (
      !session ||
      !state.realtimeTalkVideoCapable ||
      state.realtimeTalkVideoPending ||
      talkStatusIsError()
    ) {
      return;
    }
    const enabled = state.realtimeTalkVideoStream === null;
    state.realtimeTalkVideoPending = true;
    state.realtimeTalkCameraError = false;
    state.realtimeTalkDetail = null;
    state.requestUpdate();
    try {
      await session.setVideoEnabled(enabled);
    } catch (error) {
      if (state.realtimeTalkSession !== session || talkStatusIsError()) {
        return;
      }
      state.realtimeTalkVideoStream = null;
      state.realtimeTalkDetail = error instanceof Error ? error.message : String(error);
      state.realtimeTalkCameraError = true;
    } finally {
      if (state.realtimeTalkSession === session) {
        state.realtimeTalkVideoPending = false;
        state.requestUpdate();
      }
    }
  };
}
