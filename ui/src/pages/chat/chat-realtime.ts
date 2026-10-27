import type { TalkConfigResult, TalkVoiceChangeEvent } from "@openclaw/gateway-protocol";
import { createChangeListeners } from "../../../../src/shared/listeners.js";
import type { RealtimeVoiceCloseOptions } from "../../../../src/talk/provider-types.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { loadSettings, type UiSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { GatewaySpeechPlayback } from "../../lib/speech-playback.ts";
import {
  createRealtimeTalkConversationState,
  continueRealtimeTalkConversation,
  type RealtimeTalkConversationState,
} from "./talk/conversation-state.ts";
import type { RealtimeTalkCameraDevice } from "./talk/input.ts";
import { RealtimeTalkLevelSignal } from "./talk/level.ts";
import type { RealtimeTalkSession, RealtimeTalkStatus } from "./talk/session.ts";
import type { SplitTalkOptions } from "./talk/split.ts";
import { RealtimeTalkVoiceSelection } from "./talk/voice-selection.ts";

export type ChatRealtimeState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  settings: UiSettings;
  sessionKey: string;
  chatMessages: unknown[];
  lastError?: string | null;
  chatError?: string | null;
  realtimeTalk: ChatRealtimeOwner;
  resetRealtimeTalkConversation: () => void;
  toggleRealtimeTalk: () => Promise<void>;
  toggleRealtimeTalkCamera: () => Promise<void>;
  switchRealtimeTalkCamera: () => Promise<void>;
};

export type ChatRealtimeView = {
  realtimeTalkActive: boolean;
  realtimeTalkStatus: RealtimeTalkStatus;
  realtimeTalkDetail: string | null;
  realtimeTalkInputNotice: string | null;
  realtimeTalkInputLevel: RealtimeTalkLevelSignal;
  realtimeTalkVideoStream: MediaStream | null;
  realtimeTalkCameraDevices: RealtimeTalkCameraDevice[];
  realtimeTalkVideoCapable: boolean;
  realtimeTalkVideoPending: boolean;
  realtimeTalkCameraError: boolean;
};

type ChatRealtimeSnapshot = {
  realtimeTalkUseSystemDefault: (() => Promise<void>) | null;
  realtimeTalkSession: RealtimeTalkSession | null;
  realtimeTalkVoiceController: RealtimeTalkVoiceSelection | null;
  realtimeTalkConversationState: RealtimeTalkConversationState;
} & ChatRealtimeView;

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
  private readonly listeners = createChangeListeners();

  get snapshot(): Readonly<ChatRealtimeSnapshot> {
    return this.value;
  }

  update(patch: Partial<ChatRealtimeSnapshot>) {
    this.value = { ...this.value, ...patch };
    this.listeners.publish();
  }

  subscribe(listener: () => void) {
    const notify = () => listener();
    return this.listeners.subscribe(notify);
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
  let actionsRuntime: typeof import("./talk/chat-actions-runtime.ts") | undefined;
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
    let closed: Promise<void> | undefined;
    if (voiceChange) {
      const previous = state.realtimeTalk.snapshot.realtimeTalkSession;
      state.realtimeTalk.update({
        realtimeTalkSession: null,
      });
      closed = previous?.stop();
      state.realtimeTalk.update({
        realtimeTalkVideoStream: null,
        realtimeTalkCameraDevices: [],
        realtimeTalkConversationState: continueRealtimeTalkConversation(
          state.realtimeTalk.snapshot.realtimeTalkConversationState,
        ),
      });
      conversationGeneration += 1;
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
    let runtime: typeof import("./talk/chat-actions-runtime.ts");
    try {
      // Preserve Safari's gesture-bound audio preparation before loading optional code.
      playback.prepare(client, onSuperseded);
      const [result, maxTextLength, loaded] = await Promise.all([
        voiceChange ? undefined : client.request<TalkConfigResult>("talk.config", {}),
        voiceChange ? undefined : maxSpeechTextLength?.(),
        import("./talk/chat-actions-runtime.ts").then(
          ({
            startChatRealtimeSession,
            setRealtimeTalkCameraEnabled,
            switchRealtimeTalkCamera,
          }) => ({
            startChatRealtimeSession,
            setRealtimeTalkCameraEnabled,
            switchRealtimeTalkCamera,
          }),
        ),
        closed,
      ]);
      if (
        state.realtimeTalk.snapshot.realtimeTalkVoiceController !== voiceController ||
        state.client !== client ||
        !state.connected ||
        state.sessionKey !== sessionKey ||
        !canStart()
      ) {
        playback.stop();
        if (
          !voiceChange &&
          state.realtimeTalk.snapshot.realtimeTalkVoiceController === voiceController
        ) {
          stopChatRealtimeTalk(state);
        }
        return undefined;
      }
      runtime = loaded;
      actionsRuntime = loaded;
      const talk = result?.config?.talk;
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
      if (voiceChange) {
        throw error;
      }
      if (state.realtimeTalk.snapshot.realtimeTalkVoiceController === voiceController) {
        stopChatRealtimeTalk(state);
        state.realtimeTalk.update({
          realtimeTalkStatus: "error",
          realtimeTalkDetail: formatUiError(error),
        });
      }
      return undefined;
    }
    return runtime.startChatRealtimeSession(state, {
      client,
      sessionKey,
      voiceController,
      voiceChange,
      replacementTransport,
      inputDeviceId,
      videoDeviceId,
      split,
      playback,
      autoEnableCamera,
      itemPrefix,
      orderOffset,
      startRealtimeTalk,
      stopRealtimeTalk: stopChatRealtimeTalk,
    });
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
  // A call cannot exist before startup loads the runtime. Keep camera dispatch
  // synchronous afterward so disabling it retires the saved intent immediately.
  state.toggleRealtimeTalkCamera = async () =>
    actionsRuntime?.setRealtimeTalkCameraEnabled(
      state,
      state.realtimeTalk.snapshot.realtimeTalkVideoStream === null,
    );
  state.switchRealtimeTalkCamera = async () => actionsRuntime?.switchRealtimeTalkCamera(state);
}
