import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { saveSettings, type UiSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import type { RealtimeTalkOptions } from "./components/chat-realtime-controls.ts";
import {
  createRealtimeTalkConversationState,
  updateRealtimeTalkConversation,
  type RealtimeTalkConversationEntry,
  type RealtimeTalkConversationState,
} from "./realtime-talk-conversation.ts";
import { discoverRealtimeTalkInputs, type RealtimeTalkInputDevice } from "./realtime-talk-input.ts";
import {
  RealtimeTalkSession,
  type RealtimeTalkLaunchOptions,
  type RealtimeTalkStatus,
} from "./realtime-talk.ts";
import {
  RealtimeTranslationSession,
  type RealtimeTranslationDirection,
  type RealtimeTranslationInputSource,
  type RealtimeTranslationStatus,
  type RealtimeTranslationTranscript,
} from "./realtime-translation.ts";

const realtimeTalkInputDeviceIds = new Map<string, string>();

function realtimeTalkInputScope(state: Pick<ChatRealtimeState, "settings">): string {
  return state.settings.gatewayUrl.trim();
}

function currentRealtimeTalkInput(state: ChatRealtimeState): string {
  const scope = realtimeTalkInputScope(state);
  if (realtimeTalkInputDeviceIds.has(scope)) {
    return realtimeTalkInputDeviceIds.get(scope) ?? "";
  }
  const inputDeviceId = state.realtimeTalkInputDeviceId.trim();
  realtimeTalkInputDeviceIds.set(scope, inputDeviceId);
  return inputDeviceId;
}

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
  realtimeTalkConversation: RealtimeTalkConversationEntry[];
  realtimeTalkOptions: RealtimeTalkOptions;
  realtimeTalkInputDevices: RealtimeTalkInputDevice[];
  realtimeTalkInputDeviceId: string;
  realtimeTalkInputLoading: boolean;
  realtimeTalkInputError: string | null;
  realtimeTalkInputRefreshId: number;
  realtimeTalkSession: RealtimeTalkSession | null;
  realtimeTalkConversationState: RealtimeTalkConversationState;
  realtimeTranslationActive: boolean;
  realtimeTranslationStatus: RealtimeTranslationStatus;
  realtimeTranslationDetail: string | null;
  realtimeTranslationDirection: RealtimeTranslationDirection;
  realtimeTranslationInputSource: RealtimeTranslationInputSource;
  realtimeTranslationTranscripts: RealtimeTranslationTranscript[];
  realtimeTranslationSession: RealtimeTranslationSession | null;
  requestUpdate: () => void;
  updateRealtimeTalkOptions: (next: Partial<RealtimeTalkOptions>) => void;
  refreshRealtimeTalkInputs: (requestPermission?: boolean) => Promise<void>;
  selectRealtimeTalkInput: (deviceId: string) => void;
  resetRealtimeTalkConversation: () => void;
  toggleRealtimeTalk: () => Promise<void>;
  setRealtimeTranslationDirection: (direction: RealtimeTranslationDirection) => void;
  setRealtimeTranslationInputSource: (source: RealtimeTranslationInputSource) => void;
  toggleRealtimeTranslation: () => Promise<void>;
};

function createDefaultRealtimeTalkOptions(): RealtimeTalkOptions {
  return {
    model: "",
    voice: "",
    vadThreshold: "",
  };
}

export function createInitialChatRealtimeState(inputDeviceId = "") {
  return {
    realtimeTalkActive: false,
    realtimeTalkStatus: "idle" as RealtimeTalkStatus,
    realtimeTalkDetail: null,
    realtimeTalkConversation: [],
    realtimeTalkOptions: createDefaultRealtimeTalkOptions(),
    realtimeTalkInputDevices: [] as RealtimeTalkInputDevice[],
    realtimeTalkInputDeviceId: inputDeviceId,
    realtimeTalkInputLoading: false,
    realtimeTalkInputError: null,
    realtimeTalkInputRefreshId: 0,
    realtimeTalkSession: null,
    realtimeTalkConversationState: createRealtimeTalkConversationState(),
    realtimeTranslationActive: false,
    realtimeTranslationStatus: "idle" as RealtimeTranslationStatus,
    realtimeTranslationDetail: null,
    realtimeTranslationDirection: "zh-en" as RealtimeTranslationDirection,
    realtimeTranslationInputSource: "microphone" as RealtimeTranslationInputSource,
    realtimeTranslationTranscripts: [] as RealtimeTranslationTranscript[],
    realtimeTranslationSession: null,
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
  state.resetRealtimeTalkConversation();
}

async function refreshRealtimeTalkInputs(
  state: ChatRealtimeState,
  requestPermission: boolean,
): Promise<void> {
  const refreshId = ++state.realtimeTalkInputRefreshId;
  state.realtimeTalkInputLoading = true;
  state.realtimeTalkInputError = null;
  state.requestUpdate();
  try {
    const result = await discoverRealtimeTalkInputs(requestPermission);
    if (refreshId !== state.realtimeTalkInputRefreshId) {
      return;
    }
    state.realtimeTalkInputDevices = result.devices;
    state.realtimeTalkInputDeviceId = currentRealtimeTalkInput(state);
    const selectedDeviceMissing =
      requestPermission &&
      result.warning === null &&
      state.realtimeTalkInputDeviceId.length > 0 &&
      result.devices.length > 0 &&
      !result.devices.some((device) => device.deviceId === state.realtimeTalkInputDeviceId);
    state.realtimeTalkInputError = selectedDeviceMissing
      ? t("chat.composer.selectedMicrophoneUnavailable")
      : result.warning;
  } catch (error) {
    if (refreshId !== state.realtimeTalkInputRefreshId) {
      return;
    }
    state.realtimeTalkInputDevices = [];
    state.realtimeTalkInputError = error instanceof Error ? error.message : String(error);
  } finally {
    if (refreshId === state.realtimeTalkInputRefreshId) {
      state.realtimeTalkInputLoading = false;
      state.requestUpdate();
    }
  }
}

export function attachChatRealtimeActions(state: ChatRealtimeState) {
  state.resetRealtimeTalkConversation = () => {
    resetChatRealtimeConversation(state);
  };
  state.updateRealtimeTalkOptions = (next) => {
    state.realtimeTalkOptions = { ...state.realtimeTalkOptions, ...next };
    state.requestUpdate();
  };
  state.refreshRealtimeTalkInputs = (requestPermission = false) =>
    refreshRealtimeTalkInputs(state, requestPermission);
  state.selectRealtimeTalkInput = (deviceId) => {
    const normalizedDeviceId = deviceId.trim();
    realtimeTalkInputDeviceIds.set(realtimeTalkInputScope(state), normalizedDeviceId);
    state.realtimeTalkInputDeviceId = normalizedDeviceId;
    state.settings = {
      ...state.settings,
      realtimeTalkInputDeviceId: normalizedDeviceId || undefined,
    };
    saveSettings(state.settings);
    state.realtimeTalkInputError = null;
    state.requestUpdate();
  };
  state.setRealtimeTranslationDirection = (direction) => {
    if (!state.realtimeTranslationActive) {
      state.realtimeTranslationDirection = direction;
      state.requestUpdate();
    }
  };
  state.setRealtimeTranslationInputSource = (source) => {
    if (!state.realtimeTranslationActive) {
      state.realtimeTranslationInputSource = source;
      state.requestUpdate();
    }
  };
  state.toggleRealtimeTranslation = async () => {
    if (state.realtimeTranslationSession) {
      state.realtimeTranslationSession.stop();
      state.realtimeTranslationSession = null;
      state.realtimeTranslationActive = false;
      state.realtimeTranslationStatus = "idle";
      state.realtimeTranslationDetail = null;
      state.requestUpdate();
      return;
    }
    if (!state.client || !state.connected) {
      state.lastError = "Gateway not connected";
      state.chatError = state.lastError;
      state.requestUpdate();
      return;
    }
    state.realtimeTalkSession?.stop();
    state.realtimeTalkSession = null;
    state.realtimeTalkActive = false;
    state.realtimeTranslationActive = true;
    state.realtimeTranslationStatus = "connecting";
    state.realtimeTranslationDetail = null;
    state.realtimeTranslationTranscripts = [];
    const session = new RealtimeTranslationSession(
      state.client,
      state.realtimeTranslationDirection,
      state.realtimeTranslationInputSource,
      {
        onStatus: (status, detail) => {
          state.realtimeTranslationStatus = status;
          state.realtimeTranslationDetail = detail ?? null;
          state.realtimeTranslationActive = status !== "idle";
          if (status === "idle") {
            state.realtimeTranslationSession = null;
          }
          state.requestUpdate();
        },
        onTranscript: (entry) => {
          const previous = state.realtimeTranslationTranscripts.at(-1);
          if (!entry.final && previous?.role === entry.role && !previous.final) {
            state.realtimeTranslationTranscripts = [
              ...state.realtimeTranslationTranscripts.slice(0, -1),
              { ...entry, text: `${previous.text}${entry.text}` },
            ];
          } else {
            state.realtimeTranslationTranscripts = [...state.realtimeTranslationTranscripts, entry];
          }
          state.requestUpdate();
        },
      },
    );
    state.realtimeTranslationSession = session;
    try {
      await session.start();
    } catch (error) {
      session.stop();
      state.realtimeTranslationSession = null;
      state.realtimeTranslationActive = false;
      state.realtimeTranslationStatus = "error";
      state.realtimeTranslationDetail = error instanceof Error ? error.message : String(error);
      state.requestUpdate();
    }
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
    state.realtimeTranslationSession?.stop();
    state.realtimeTranslationSession = null;
    state.realtimeTranslationActive = false;
    const inputDeviceId = currentRealtimeTalkInput(state) || undefined;
    const options = state.realtimeTalkOptions;
    const launchOptions: RealtimeTalkLaunchOptions = {
      model: options.model.trim() || undefined,
      voice: options.voice.trim() || undefined,
      vadThreshold: Number(options.vadThreshold) || undefined,
    };
    state.realtimeTalkInputDeviceId = inputDeviceId ?? "";
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
          state.realtimeTalkConversationState = updateRealtimeTalkConversation(
            state.realtimeTalkConversationState,
            entry,
          );
          state.realtimeTalkConversation = state.realtimeTalkConversationState.entries;
          state.requestUpdate();
        },
      },
      launchOptions,
      { inputDeviceId },
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
