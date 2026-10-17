import type { TalkConfigResult, TalkVoiceChangeEvent } from "@openclaw/gateway-protocol";
import type { RealtimeVoiceCloseOptions } from "../../../../src/talk/provider-types.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { loadSettings, patchSettings, type UiSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import { GatewaySpeechPlayback } from "../../lib/speech-playback.ts";
import {
  createRealtimeTalkConversationState,
  continueRealtimeTalkConversation,
  orderRealtimeTalkConversation,
  updateRealtimeTalkConversation,
  type RealtimeTalkConversationState,
} from "./talk/conversation.ts";
import {
  discoverRealtimeTalkCameras,
  RealtimeTalkSelectedMicrophoneError,
  type RealtimeTalkCameraDevice,
} from "./talk/input.ts";
import { RealtimeTalkLevelSignal } from "./talk/level.ts";
import { RealtimeTalkSession, type RealtimeTalkStatus } from "./talk/session.ts";
import type { SplitTalkOptions } from "./talk/split.ts";
import { RealtimeTalkVoiceSelection } from "./talk/voice-selection.ts";

export type ChatRealtimeState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  settings: UiSettings;
  sessionKey: string;
  lastError?: string | null;
  chatError?: string | null;
  realtimeTalk: ChatRealtimeOwner;
  requestUpdate?: () => void;
  resetRealtimeTalkConversation: () => void;
  toggleRealtimeTalk: () => Promise<void>;
  toggleRealtimeTalkCamera: () => Promise<void>;
  switchRealtimeTalkCamera: () => Promise<void>;
};

type ChatRealtimeSnapshot = {
  realtimeTalkActive: boolean;
  realtimeTalkStatus: RealtimeTalkStatus;
  realtimeTalkDetail: string | null;
  realtimeTalkInputNotice: string | null;
  realtimeTalkUseSystemDefault: (() => Promise<void>) | null;
  realtimeTalkInputLevel: RealtimeTalkLevelSignal;
  realtimeTalkVideoStream: MediaStream | null;
  realtimeTalkCameraDevices: RealtimeTalkCameraDevice[];
  realtimeTalkVideoCapable: boolean;
  realtimeTalkVideoPending: boolean;
  realtimeTalkCameraError: boolean;
  realtimeTalkSession: RealtimeTalkSession | null;
  realtimeTalkVoiceController: RealtimeTalkVoiceSelection | null;
  realtimeTalkConversationState: RealtimeTalkConversationState;
};

/** Synchronous call/device authority; projections observe complete state transitions. */
class ChatRealtimeOwner {
  private value: ChatRealtimeSnapshot = {
    realtimeTalkActive: false,
    realtimeTalkStatus: "idle",
    realtimeTalkDetail: null,
    realtimeTalkInputNotice: null,
    realtimeTalkUseSystemDefault: null,
    realtimeTalkInputLevel: new RealtimeTalkLevelSignal(),
    realtimeTalkVideoStream: null,
    realtimeTalkCameraDevices: [],
    realtimeTalkVideoCapable: false,
    realtimeTalkVideoPending: false,
    realtimeTalkCameraError: false,
    realtimeTalkSession: null,
    realtimeTalkVoiceController: null,
    realtimeTalkConversationState: createRealtimeTalkConversationState(),
  };
  private readonly listeners = new Set<() => void>();

  get snapshot(): Readonly<ChatRealtimeSnapshot> {
    return this.value;
  }

  update(patch: Partial<ChatRealtimeSnapshot>) {
    this.value = { ...this.value, ...patch };
    for (const listener of this.listeners) {
      listener();
    }
  }

  subscribe(listener: () => void) {
    const notify = () => listener();
    this.listeners.add(notify);
    return () => {
      this.listeners.delete(notify);
    };
  }
}

export function createInitialChatRealtimeState(): Pick<ChatRealtimeState, "realtimeTalk"> {
  return { realtimeTalk: new ChatRealtimeOwner() };
}

export function stopChatRealtimeTalk(
  state: ChatRealtimeState,
  options: RealtimeVoiceCloseOptions & { preserveConversation?: boolean } = {},
) {
  const session = state.realtimeTalk.snapshot.realtimeTalkSession;
  state.realtimeTalk.snapshot.realtimeTalkVoiceController?.dispose();
  // Retire callback ownership before stop() can synchronously report idle.
  // Otherwise a closing session can still mutate the newly selected route.
  state.realtimeTalk.snapshot.realtimeTalkInputLevel.set(0);
  state.realtimeTalk.update({
    realtimeTalkVoiceController: null,
    realtimeTalkSession: null,
    realtimeTalkUseSystemDefault: null,
    realtimeTalkActive: false,
    realtimeTalkStatus: "idle",
    realtimeTalkDetail: null,
    realtimeTalkInputNotice: null,
    realtimeTalkVideoStream: null,
    realtimeTalkCameraDevices: [],
    realtimeTalkVideoCapable: false,
    realtimeTalkVideoPending: false,
    realtimeTalkCameraError: false,
    realtimeTalkConversationState: options.preserveConversation
      ? continueRealtimeTalkConversation(state.realtimeTalk.snapshot.realtimeTalkConversationState)
      : createRealtimeTalkConversationState(),
  });
  void session?.stop({ disposition: options.disposition ?? "detach" });
}

export function dismissRealtimeTalkError(state: ChatRealtimeState) {
  if (state.realtimeTalk.snapshot.realtimeTalkStatus !== "error") {
    return;
  }
  stopChatRealtimeTalk(state);
}

export function attachChatRealtimeActions(
  state: ChatRealtimeState,
  canStart: () => boolean = () => true,
  sendMessage?: SplitTalkOptions["sendMessage"],
  maxSpeechTextLength?: () => number | Promise<number>,
) {
  let conversationGeneration = 0;
  const talkStatusIsError = () => state.realtimeTalk.snapshot.realtimeTalkStatus === "error";
  const persistCameraPreference = (enabled: boolean) => {
    state.settings = patchSettings({ talkCameraAutoEnable: enabled });
  };
  const showCameraError = (error: unknown) => {
    state.realtimeTalk.update({
      realtimeTalkDetail: formatUiError(error),
      realtimeTalkCameraError: true,
    });
  };
  const refreshCameraDevices = async (session: RealtimeTalkSession) => {
    const result = await discoverRealtimeTalkCameras(() => false);
    if (state.realtimeTalk.snapshot.realtimeTalkSession !== session) {
      return;
    }
    state.realtimeTalk.update({
      realtimeTalkCameraDevices: result.devices,
    });
  };
  const setRealtimeTalkCameraEnabled = async (
    enabled: boolean,
    options: { disableAutoEnableOnFailure?: boolean } = {},
  ) => {
    const session = state.realtimeTalk.snapshot.realtimeTalkSession;
    if (
      !session ||
      !state.realtimeTalk.snapshot.realtimeTalkVideoCapable ||
      state.realtimeTalk.snapshot.realtimeTalkVideoPending ||
      talkStatusIsError()
    ) {
      return;
    }
    state.realtimeTalk.update({
      realtimeTalkVideoPending: true,
      realtimeTalkCameraError: false,
      realtimeTalkDetail: null,
    });
    if (!enabled) {
      persistCameraPreference(false);
    }
    try {
      if (enabled) {
        await session.switchCamera(loadSettings().realtimeTalkVideoDeviceId);
      }
      await session.setVideoEnabled(enabled);
    } catch (error) {
      if (state.realtimeTalk.snapshot.realtimeTalkSession !== session || talkStatusIsError()) {
        return;
      }
      if (options.disableAutoEnableOnFailure) {
        persistCameraPreference(false);
      }
      state.realtimeTalk.update({
        realtimeTalkVideoStream: null,
      });
      showCameraError(error);
    } finally {
      if (state.realtimeTalk.snapshot.realtimeTalkSession === session) {
        state.realtimeTalk.update({
          realtimeTalkVideoPending: false,
        });
      }
    }
  };
  state.resetRealtimeTalkConversation = () => {
    state.realtimeTalk.update({
      realtimeTalkConversationState: createRealtimeTalkConversationState(),
    });
  };
  const startRealtimeTalk = async (
    useSystemDefault = false,
    voiceChange?: TalkVoiceChangeEvent,
  ): Promise<RealtimeTalkSession | undefined> => {
    state.realtimeTalk.update({
      realtimeTalkUseSystemDefault: null,
    });
    if (!canStart()) {
      return undefined;
    }
    if (!state.client || !state.connected) {
      state.lastError = "Gateway not connected";
      state.chatError = state.lastError;
      state.requestUpdate?.();
      return undefined;
    }
    // Re-read persisted settings so device choices made elsewhere apply to the
    // next talk session without a reload.
    const talkSettings = loadSettings();
    const inputDeviceId = useSystemDefault
      ? undefined
      : talkSettings.realtimeTalkInputDeviceId?.trim() || undefined;
    const { client, sessionKey } = state;
    let voiceController = state.realtimeTalk.snapshot.realtimeTalkVoiceController;
    const playback = new GatewaySpeechPlayback();
    const onSuperseded = () => {
      if (state.realtimeTalk.snapshot.realtimeTalkVoiceController === voiceController) {
        stopChatRealtimeTalk(state);
      }
    };
    const replacementTransport = voiceChange
      ? state.realtimeTalk.snapshot.realtimeTalkSession?.getTransport()
      : undefined;
    if (voiceChange && !replacementTransport) {
      throw new Error(t("chat.voice.selectionFailed"));
    }
    if (voiceChange) {
      const previous = state.realtimeTalk.snapshot.realtimeTalkSession;
      const previousController = state.realtimeTalk.snapshot.realtimeTalkVoiceController;
      state.realtimeTalk.update({
        realtimeTalkSession: null,
      });
      const closed = previous?.stop();
      state.realtimeTalk.update({
        realtimeTalkVideoStream: null,
        realtimeTalkCameraDevices: [],
        realtimeTalkConversationState: continueRealtimeTalkConversation(
          state.realtimeTalk.snapshot.realtimeTalkConversationState,
        ),
      });
      conversationGeneration += 1;
      try {
        playback.prepare(client, onSuperseded);
        await closed;
      } catch (error) {
        playback.stop();
        throw error;
      }
      if (
        state.realtimeTalk.snapshot.realtimeTalkVoiceController !== previousController ||
        state.client !== client ||
        state.sessionKey !== sessionKey ||
        !state.connected ||
        !canStart()
      ) {
        playback.stop();
        return undefined;
      }
    } else {
      conversationGeneration = 0;
      state.realtimeTalk.snapshot.realtimeTalkVoiceController?.dispose();
      const controller: RealtimeTalkVoiceSelection = new RealtimeTalkVoiceSelection({
        client,
        sessionKey,
        isCurrent: () =>
          state.realtimeTalk.snapshot.realtimeTalkVoiceController === controller &&
          state.client === client &&
          state.sessionKey === sessionKey &&
          state.connected,
        currentCall: () => state.realtimeTalk.snapshot.realtimeTalkSession,
        restart: (request) => startRealtimeTalk(useSystemDefault, request),
        cancel: (message) => {
          stopChatRealtimeTalk(state, { preserveConversation: true });
          state.realtimeTalk.update({
            realtimeTalkStatus: "error",
            realtimeTalkDetail: message,
          });
        },
      });
      voiceController = controller;
      state.realtimeTalk.update({
        realtimeTalkVoiceController: controller,
      });
    }
    const itemPrefix = voiceChange ? `voice-${conversationGeneration}:` : "";
    const orderOffset = voiceChange
      ? state.realtimeTalk.snapshot.realtimeTalkConversationState.entries.length
      : 0;
    const videoDeviceId = talkSettings.realtimeTalkVideoDeviceId?.trim() || undefined;
    const autoEnableCamera = talkSettings.talkCameraAutoEnable === true;
    let autoEnableCameraAttempted = false;
    state.realtimeTalk.update({
      realtimeTalkActive: true,
      realtimeTalkStatus: "connecting",
      realtimeTalkDetail: null,
      realtimeTalkInputNotice: null,
      realtimeTalkVideoCapable: false,
      realtimeTalkVideoPending: false,
      realtimeTalkCameraError: false,
    });
    state.realtimeTalk.snapshot.realtimeTalkInputLevel.set(0);
    if (!voiceChange) {
      state.resetRealtimeTalkConversation();
    }
    let split: SplitTalkOptions | undefined;
    if (!voiceChange) {
      try {
        playback.prepare(client, onSuperseded);
        const [result, maxTextLength] = await Promise.all([
          client.request<TalkConfigResult>("talk.config", {}),
          maxSpeechTextLength?.(),
        ]);
        if (
          state.realtimeTalk.snapshot.realtimeTalkVoiceController !== voiceController ||
          state.client !== client ||
          !state.connected ||
          state.sessionKey !== sessionKey ||
          !canStart()
        ) {
          playback.stop();
          if (state.realtimeTalk.snapshot.realtimeTalkVoiceController === voiceController) {
            stopChatRealtimeTalk(state);
          }
          return undefined;
        }
        const talk = result.config?.talk;
        if (talk?.realtime?.mode === "stt-tts") {
          if (!sendMessage) {
            throw new Error(t("chat.voice.replyFailed"));
          }
          split = {
            silenceTimeoutMs: talk.silenceTimeoutMs ?? 900,
            speechMethod: talk.provider || talk.resolved?.provider ? "talk.speak" : "tts.speak",
            sendMessage,
            playback,
            maxTextLength,
          };
        }
      } catch (error) {
        playback.stop();
        if (state.realtimeTalk.snapshot.realtimeTalkVoiceController === voiceController) {
          stopChatRealtimeTalk(state);
          state.realtimeTalk.update({
            realtimeTalkStatus: "error",
            realtimeTalkDetail: formatUiError(error),
          });
        }
        return undefined;
      }
    }
    const forCurrentSession =
      <Args extends unknown[]>(callback: (...args: Args) => void) =>
      (...args: Args) => {
        if (state.realtimeTalk.snapshot.realtimeTalkSession === session) {
          callback(...args);
        }
      };
    const session: RealtimeTalkSession = new RealtimeTalkSession(
      client,
      sessionKey,
      {
        onStatus: forCurrentSession((status, detail) => {
          state.realtimeTalk.update({
            realtimeTalkStatus: status,
            realtimeTalkDetail:
              status === "error" && detail ? formatUiExternalText(detail) : (detail ?? null),
            realtimeTalkCameraError: false,
            realtimeTalkActive: status !== "idle",
          });
          if (status === "idle" || status === "error") {
            state.realtimeTalk.update({
              realtimeTalkInputNotice: null,
            });
            state.realtimeTalk.snapshot.realtimeTalkInputLevel.set(0);
          }
          if (status === "error") {
            voiceController?.failed(session);
          }
          // Remembered camera intent waits for "listening": capability is reported
          // before transport start, and acquiring the camera while microphone
          // startup can still fail would prompt for a call that never happens.
          if (
            status === "listening" &&
            state.realtimeTalk.snapshot.realtimeTalkVideoCapable &&
            autoEnableCamera &&
            !autoEnableCameraAttempted
          ) {
            autoEnableCameraAttempted = true;
            void setRealtimeTalkCameraEnabled(true, { disableAutoEnableOnFailure: true });
          }
        }),
        onInputNotice: forCurrentSession((detail) => {
          state.realtimeTalk.update({
            realtimeTalkInputNotice: formatUiExternalText(detail),
          });
        }),
        onVideoCapability: forCurrentSession((capable) => {
          state.realtimeTalk.update({
            realtimeTalkVideoCapable: capable,
          });
        }),
        onInputLevel: forCurrentSession((level) => {
          state.realtimeTalk.snapshot.realtimeTalkInputLevel.set(level);
        }),
        onTranscript: forCurrentSession((entry) => {
          state.realtimeTalk.update({
            realtimeTalkConversationState: updateRealtimeTalkConversation(
              state.realtimeTalk.snapshot.realtimeTalkConversationState,
              entry.itemId === undefined
                ? entry
                : {
                    ...entry,
                    itemId: `${itemPrefix}${entry.itemId}`,
                    order: entry.order === undefined ? undefined : orderOffset + entry.order,
                  },
            ),
          });
        }),
        onTranscriptOrder: forCurrentSession((orders) => {
          state.realtimeTalk.update({
            realtimeTalkConversationState: orderRealtimeTalkConversation(
              state.realtimeTalk.snapshot.realtimeTalkConversationState,
              orders.map(({ itemId, order }) => ({
                itemId: `${itemPrefix}${itemId}`,
                order: orderOffset + order,
              })),
            ),
          });
        }),
        onVideoStream: forCurrentSession((stream) => {
          if (stream && state.realtimeTalk.snapshot.realtimeTalkStatus === "error") {
            void session.setVideoEnabled(false).catch(() => undefined);
            return;
          }
          state.realtimeTalk.update({
            realtimeTalkVideoStream: stream,
          });
          if (stream) {
            persistCameraPreference(true);
            state.realtimeTalk.update({
              realtimeTalkDetail: null,
              realtimeTalkCameraError: false,
            });
            void refreshCameraDevices(session);
          }
        }),
        onVideoError: forCurrentSession((error) => {
          if (!talkStatusIsError()) {
            showCameraError(error);
          }
        }),
        onTalkEvent: forCurrentSession((event) => {
          if (state.client !== client || state.sessionKey !== sessionKey) {
            return;
          }
          if (event.type === "session.ready") {
            voiceController?.ready(session);
          } else if (event.type === "session.closed") {
            voiceController?.failed(session);
          }
        }),
      },
      voiceChange
        ? {
            voice: voiceChange.voice,
            voiceChangeId: voiceChange.changeId,
            transport: replacementTransport,
          }
        : {},
      { inputDeviceId, videoDeviceId, split, playback },
    );
    state.realtimeTalk.update({
      realtimeTalkSession: session,
    });
    try {
      await session.start();
      return state.realtimeTalk.snapshot.realtimeTalkSession === session ? session : undefined;
    } catch (error) {
      if (state.realtimeTalk.snapshot.realtimeTalkSession !== session) {
        return undefined;
      }
      if (voiceChange) {
        throw error;
      }
      const detail = formatUiError(error);
      stopChatRealtimeTalk(state);
      state.realtimeTalk.update({
        realtimeTalkStatus: "error",
        realtimeTalkDetail: detail,
      });
      if (error instanceof RealtimeTalkSelectedMicrophoneError) {
        const retry = async () => {
          // This exact failed attempt owns consent. Stop/dismiss/route teardown or
          // another start revokes it; consume synchronously before any async work.
          if (state.realtimeTalk.snapshot.realtimeTalkUseSystemDefault !== retry) {
            return;
          }
          state.realtimeTalk.update({
            realtimeTalkUseSystemDefault: null,
          });
          if (!state.connected || state.client !== client || state.sessionKey !== sessionKey) {
            return;
          }
          await startRealtimeTalk(true);
        };
        state.realtimeTalk.update({
          realtimeTalkUseSystemDefault: retry,
        });
      }
    }
    return undefined;
  };
  state.toggleRealtimeTalk = async () => {
    if (
      state.realtimeTalk.snapshot.realtimeTalkSession ||
      state.realtimeTalk.snapshot.realtimeTalkActive
    ) {
      stopChatRealtimeTalk(state, { disposition: "abort" });
      return;
    }
    await startRealtimeTalk();
  };
  state.toggleRealtimeTalkCamera = async () =>
    setRealtimeTalkCameraEnabled(state.realtimeTalk.snapshot.realtimeTalkVideoStream === null);
  state.switchRealtimeTalkCamera = async () => {
    const session = state.realtimeTalk.snapshot.realtimeTalkSession;
    const stream = state.realtimeTalk.snapshot.realtimeTalkVideoStream;
    const devices = state.realtimeTalk.snapshot.realtimeTalkCameraDevices;
    if (
      !session ||
      !stream ||
      devices.length < 2 ||
      state.realtimeTalk.snapshot.realtimeTalkVideoPending
    ) {
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

    state.realtimeTalk.update({
      realtimeTalkVideoPending: true,
      realtimeTalkCameraError: false,
      realtimeTalkDetail: null,
    });
    try {
      await session.switchCamera(nextDevice.deviceId);
      if (state.realtimeTalk.snapshot.realtimeTalkSession === session) {
        state.settings = patchSettings({ realtimeTalkVideoDeviceId: nextDevice.deviceId });
      }
    } catch (error) {
      if (state.realtimeTalk.snapshot.realtimeTalkSession === session && !talkStatusIsError()) {
        showCameraError(error);
      }
    } finally {
      if (state.realtimeTalk.snapshot.realtimeTalkSession === session) {
        state.realtimeTalk.update({
          realtimeTalkVideoPending: false,
        });
      }
    }
  };
}
