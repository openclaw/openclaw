import type { TalkVoiceChangeEvent } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { loadSettings, patchSettings, type UiSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import {
  createRealtimeTalkConversationState,
  continueRealtimeTalkConversation,
  orderRealtimeTalkConversation,
  updateRealtimeTalkConversation,
  type RealtimeTalkConversationEntry,
  type RealtimeTalkConversationState,
} from "./talk/conversation.ts";
import {
  discoverRealtimeTalkCameras,
  RealtimeTalkSelectedMicrophoneError,
  type RealtimeTalkCameraDevice,
} from "./talk/input.ts";
import { RealtimeTalkLevelSignal } from "./talk/level.ts";
import { RealtimeTalkSession, type RealtimeTalkStatus } from "./talk/session.ts";
import {
  RealtimeTalkVoiceSelection,
  type RealtimeVoiceSelectionState,
} from "./talk/voice-selection.ts";

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
  realtimeTalkUseSystemDefault: (() => Promise<void>) | null;
  realtimeTalkInputLevel: RealtimeTalkLevelSignal;
  realtimeTalkConversation: RealtimeTalkConversationEntry[];
  realtimeTalkVideoStream: MediaStream | null;
  realtimeTalkCameraDevices: RealtimeTalkCameraDevice[];
  realtimeTalkVideoCapable: boolean;
  realtimeTalkVideoPending: boolean;
  realtimeTalkCameraError: boolean;
  realtimeTalkSession: RealtimeTalkSession | null;
  realtimeTalkVoiceController: RealtimeTalkVoiceSelection | null;
  realtimeTalkVoice: RealtimeVoiceSelectionState;
  realtimeTalkConversationState: RealtimeTalkConversationState;
  requestUpdate: () => void;
  resetRealtimeTalkConversation: () => void;
  toggleRealtimeTalk: () => Promise<void>;
  toggleRealtimeTalkCamera: () => Promise<void>;
  switchRealtimeTalkCamera: () => Promise<void>;
  selectRealtimeTalkVoice: (voice: string) => Promise<void>;
};

export function createInitialChatRealtimeState(): Pick<
  ChatRealtimeState,
  Extract<keyof ChatRealtimeState, `realtimeTalk${string}`>
> {
  return {
    realtimeTalkActive: false,
    realtimeTalkStatus: "idle",
    realtimeTalkDetail: null,
    realtimeTalkUseSystemDefault: null,
    realtimeTalkInputLevel: new RealtimeTalkLevelSignal(),
    realtimeTalkConversation: [],
    realtimeTalkVideoStream: null,
    realtimeTalkCameraDevices: [],
    realtimeTalkVideoCapable: false,
    realtimeTalkVideoPending: false,
    realtimeTalkCameraError: false,
    realtimeTalkSession: null,
    realtimeTalkVoiceController: null,
    realtimeTalkVoice: { selection: null, changing: false, error: null },
    realtimeTalkConversationState: createRealtimeTalkConversationState(),
  };
}

function resetChatRealtimeConversation(state: ChatRealtimeState) {
  state.realtimeTalkConversationState = createRealtimeTalkConversationState();
  state.realtimeTalkConversation = [];
}

export function stopChatRealtimeTalk(
  state: ChatRealtimeState,
  options: { preserveConversation?: boolean } = {},
) {
  const session = state.realtimeTalkSession;
  state.realtimeTalkVoiceController?.dispose();
  state.realtimeTalkVoiceController = null;
  state.realtimeTalkVoice = { selection: null, changing: false, error: null };
  // Retire callback ownership before stop() can synchronously report idle.
  // Otherwise a closing session can still mutate the newly selected route.
  state.realtimeTalkSession = null;
  state.realtimeTalkUseSystemDefault = null;
  state.realtimeTalkActive = false;
  state.realtimeTalkStatus = "idle";
  state.realtimeTalkDetail = null;
  state.realtimeTalkInputLevel.set(0);
  state.realtimeTalkVideoStream = null;
  state.realtimeTalkCameraDevices = [];
  state.realtimeTalkVideoCapable = false;
  state.realtimeTalkVideoPending = false;
  state.realtimeTalkCameraError = false;
  if (options.preserveConversation) {
    state.realtimeTalkConversationState = continueRealtimeTalkConversation(
      state.realtimeTalkConversationState,
    );
    state.realtimeTalkConversation = state.realtimeTalkConversationState.entries;
  } else {
    resetChatRealtimeConversation(state);
  }
  session?.stop();
}

export function dismissRealtimeTalkError(state: ChatRealtimeState) {
  if (state.realtimeTalkStatus !== "error") {
    return;
  }
  stopChatRealtimeTalk(state);
}

export function attachChatRealtimeActions(state: ChatRealtimeState) {
  let conversationGeneration = 0;
  const talkStatusIsError = () => state.realtimeTalkStatus === "error";
  const persistCameraPreference = (enabled: boolean) => {
    state.settings = patchSettings({ talkCameraAutoEnable: enabled });
  };
  const showCameraError = (error: unknown) => {
    state.realtimeTalkDetail = formatUiError(error);
    state.realtimeTalkCameraError = true;
    state.requestUpdate();
  };
  const refreshCameraDevices = async (session: RealtimeTalkSession) => {
    const result = await discoverRealtimeTalkCameras(() => false);
    if (state.realtimeTalkSession !== session) {
      return;
    }
    state.realtimeTalkCameraDevices = result.devices;
    state.requestUpdate();
  };
  const setRealtimeTalkCameraEnabled = async (
    enabled: boolean,
    options: { disableAutoEnableOnFailure?: boolean } = {},
  ) => {
    const session = state.realtimeTalkSession;
    if (
      !session ||
      !state.realtimeTalkVideoCapable ||
      state.realtimeTalkVideoPending ||
      talkStatusIsError()
    ) {
      return;
    }
    state.realtimeTalkVideoPending = true;
    state.realtimeTalkCameraError = false;
    state.realtimeTalkDetail = null;
    state.requestUpdate();
    if (!enabled) {
      persistCameraPreference(false);
    }
    try {
      if (enabled) {
        await session.switchCamera(loadSettings().realtimeTalkVideoDeviceId);
      }
      await session.setVideoEnabled(enabled);
    } catch (error) {
      if (state.realtimeTalkSession !== session || talkStatusIsError()) {
        return;
      }
      if (options.disableAutoEnableOnFailure) {
        persistCameraPreference(false);
      }
      state.realtimeTalkVideoStream = null;
      showCameraError(error);
    } finally {
      if (state.realtimeTalkSession === session) {
        state.realtimeTalkVideoPending = false;
        state.requestUpdate();
      }
    }
  };
  state.resetRealtimeTalkConversation = () => {
    resetChatRealtimeConversation(state);
  };
  const startRealtimeTalk = async (
    useSystemDefault = false,
    voiceChange?: TalkVoiceChangeEvent,
  ): Promise<RealtimeTalkSession | undefined> => {
    state.realtimeTalkUseSystemDefault = null;
    if (!state.client || !state.connected) {
      state.lastError = "Gateway not connected";
      state.chatError = state.lastError;
      state.requestUpdate();
      return undefined;
    }
    // Re-read persisted settings so device choices made elsewhere apply to the
    // next talk session without a reload.
    const talkSettings = loadSettings();
    const inputDeviceId = useSystemDefault
      ? undefined
      : talkSettings.realtimeTalkInputDeviceId?.trim() || undefined;
    const { client, sessionKey } = state;
    const replacementTransport = voiceChange
      ? state.realtimeTalkSession?.getTransport()
      : undefined;
    if (voiceChange && !replacementTransport) {
      throw new Error(t("chat.voice.selectionFailed"));
    }
    if (voiceChange) {
      const previous = state.realtimeTalkSession;
      state.realtimeTalkSession = null;
      previous?.stop();
      state.realtimeTalkConversationState = continueRealtimeTalkConversation(
        state.realtimeTalkConversationState,
      );
      state.realtimeTalkConversation = state.realtimeTalkConversationState.entries;
      conversationGeneration += 1;
    } else {
      conversationGeneration = 0;
      state.realtimeTalkVoiceController?.dispose();
      const controller: RealtimeTalkVoiceSelection = new RealtimeTalkVoiceSelection({
        client,
        sessionKey,
        isCurrent: () =>
          state.realtimeTalkVoiceController === controller &&
          state.client === client &&
          state.sessionKey === sessionKey &&
          state.connected,
        currentCall: () => state.realtimeTalkSession,
        restart: (request) => startRealtimeTalk(useSystemDefault, request),
        cancel: (message) => {
          stopChatRealtimeTalk(state, { preserveConversation: true });
          state.realtimeTalkStatus = "error";
          state.realtimeTalkDetail = message;
          state.requestUpdate();
        },
        update: (voice) => {
          state.realtimeTalkVoice = voice;
          state.requestUpdate();
        },
      });
      state.realtimeTalkVoiceController = controller;
    }
    const voiceController = state.realtimeTalkVoiceController;
    const itemPrefix = voiceChange ? `voice-${conversationGeneration}:` : "";
    const orderOffset = voiceChange ? state.realtimeTalkConversation.length : 0;
    const videoDeviceId = talkSettings.realtimeTalkVideoDeviceId?.trim() || undefined;
    const autoEnableCamera = talkSettings.talkCameraAutoEnable === true;
    let autoEnableCameraAttempted = false;
    state.realtimeTalkActive = true;
    state.realtimeTalkStatus = "connecting";
    state.realtimeTalkDetail = null;
    state.realtimeTalkVideoCapable = false;
    state.realtimeTalkVideoPending = false;
    state.realtimeTalkCameraError = false;
    state.realtimeTalkInputLevel.set(0);
    if (!voiceChange) {
      state.resetRealtimeTalkConversation();
    }
    const session = new RealtimeTalkSession(
      client,
      sessionKey,
      {
        onStatus: (status, detail) => {
          if (state.realtimeTalkSession !== session) {
            return;
          }
          state.realtimeTalkStatus = status;
          state.realtimeTalkDetail =
            status === "error" && detail ? formatUiExternalText(detail) : (detail ?? null);
          state.realtimeTalkCameraError = false;
          state.realtimeTalkActive = status !== "idle";
          if (status === "idle" || status === "error") {
            state.realtimeTalkInputLevel.set(0);
          }
          state.requestUpdate();
          if (status === "error") {
            voiceController?.failed(session);
          }
          // Remembered camera intent waits for "listening": capability is reported
          // before transport start, and acquiring the camera while microphone
          // startup can still fail would prompt for a call that never happens.
          if (
            status === "listening" &&
            state.realtimeTalkVideoCapable &&
            autoEnableCamera &&
            !autoEnableCameraAttempted
          ) {
            autoEnableCameraAttempted = true;
            void setRealtimeTalkCameraEnabled(true, { disableAutoEnableOnFailure: true });
          }
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
            entry.itemId === undefined
              ? entry
              : {
                  ...entry,
                  itemId: `${itemPrefix}${entry.itemId}`,
                  order: entry.order === undefined ? undefined : orderOffset + entry.order,
                },
          );
          state.realtimeTalkConversation = state.realtimeTalkConversationState.entries;
          state.requestUpdate();
        },
        onTranscriptOrder: (orders) => {
          if (state.realtimeTalkSession !== session) {
            return;
          }
          state.realtimeTalkConversationState = orderRealtimeTalkConversation(
            state.realtimeTalkConversationState,
            orders.map(({ itemId, order }) => ({
              itemId: `${itemPrefix}${itemId}`,
              order: orderOffset + order,
            })),
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
            persistCameraPreference(true);
            state.realtimeTalkDetail = null;
            state.realtimeTalkCameraError = false;
            void refreshCameraDevices(session);
          }
          state.requestUpdate();
        },
        onVideoError: (error) => {
          if (state.realtimeTalkSession === session && !talkStatusIsError()) {
            showCameraError(error);
          }
        },
        onTalkEvent: (event) => {
          if (
            state.realtimeTalkSession !== session ||
            state.client !== client ||
            state.sessionKey !== sessionKey
          ) {
            return;
          }
          if (event.type === "session.ready") {
            voiceController?.ready(session);
          } else if (event.type === "session.closed") {
            voiceController?.failed(session);
          }
        },
      },
      voiceChange
        ? {
            voice: voiceChange.voice,
            voiceChangeId: voiceChange.changeId,
            transport: replacementTransport,
          }
        : {},
      { inputDeviceId, videoDeviceId },
    );
    state.realtimeTalkSession = session;
    try {
      await session.start();
      return state.realtimeTalkSession === session ? session : undefined;
    } catch (error) {
      if (state.realtimeTalkSession !== session) {
        return undefined;
      }
      if (voiceChange) {
        throw error;
      }
      const detail = formatUiError(error);
      stopChatRealtimeTalk(state);
      state.realtimeTalkStatus = "error";
      state.realtimeTalkDetail = detail;
      if (error instanceof RealtimeTalkSelectedMicrophoneError) {
        const retry = async () => {
          // This exact failed attempt owns consent. Stop/dismiss/route teardown or
          // another start revokes it; consume synchronously before any async work.
          if (state.realtimeTalkUseSystemDefault !== retry) {
            return;
          }
          state.realtimeTalkUseSystemDefault = null;
          if (!state.connected || state.client !== client || state.sessionKey !== sessionKey) {
            state.requestUpdate();
            return;
          }
          await startRealtimeTalk(true);
        };
        state.realtimeTalkUseSystemDefault = retry;
      }
      state.requestUpdate();
    }
    return undefined;
  };
  state.selectRealtimeTalkVoice = async (voice) => {
    await state.realtimeTalkVoiceController?.set(voice);
  };
  state.toggleRealtimeTalk = async () => {
    if (state.realtimeTalkSession) {
      stopChatRealtimeTalk(state);
      state.requestUpdate();
      return;
    }
    await startRealtimeTalk();
  };
  state.toggleRealtimeTalkCamera = async () => {
    const enabled = state.realtimeTalkVideoStream === null;
    await setRealtimeTalkCameraEnabled(enabled);
  };
  state.switchRealtimeTalkCamera = async () => {
    const session = state.realtimeTalkSession;
    const stream = state.realtimeTalkVideoStream;
    const devices = state.realtimeTalkCameraDevices;
    if (!session || !stream || devices.length < 2 || state.realtimeTalkVideoPending) {
      return;
    }
    const activeDeviceId =
      stream.getVideoTracks()[0]?.getSettings?.().deviceId?.trim() ||
      loadSettings().realtimeTalkVideoDeviceId?.trim();
    const activeIndex = devices.findIndex((device) => device.deviceId === activeDeviceId);
    const nextDevice = devices[(activeIndex + 1) % devices.length];
    if (!nextDevice) {
      return;
    }

    state.realtimeTalkVideoPending = true;
    state.realtimeTalkCameraError = false;
    state.realtimeTalkDetail = null;
    state.requestUpdate();
    try {
      await session.switchCamera(nextDevice.deviceId);
      if (state.realtimeTalkSession === session) {
        state.settings = patchSettings({ realtimeTalkVideoDeviceId: nextDevice.deviceId });
      }
    } catch (error) {
      if (state.realtimeTalkSession === session && !talkStatusIsError()) {
        showCameraError(error);
      }
    } finally {
      if (state.realtimeTalkSession === session) {
        state.realtimeTalkVideoPending = false;
        state.requestUpdate();
      }
    }
  };
}
