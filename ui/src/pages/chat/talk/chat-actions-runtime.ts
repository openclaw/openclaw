import type { TalkVoiceChangeEvent } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import { loadSettings, patchSettings } from "../../../app/settings.ts";
import { formatUiError, formatUiExternalText } from "../../../lib/format-error.ts";
import type { GatewaySpeechPlayback } from "../../../lib/speech-playback.ts";
import type { ChatRealtimeState, stopChatRealtimeTalk } from "../chat-realtime.ts";
import { persistedMessageEntryId } from "../chat-thread-items.ts";
import { orderRealtimeTalkConversation, updateRealtimeTalkConversation } from "./conversation.ts";
import { discoverRealtimeTalkCameras, RealtimeTalkSelectedMicrophoneError } from "./input.ts";
import { RealtimeTalkSession } from "./session.ts";
import type { SplitTalkOptions } from "./split.ts";
import { RealtimeTalkVoiceSelection } from "./voice-selection.ts";

/** Where a new caption starts: after the newest saved message, or first in an empty chat. */
function latestSavedMessageId(messages: readonly unknown[]): string | null | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const id = persistedMessageEntryId(messages[index]);
    if (id) {
      return id;
    }
  }
  return messages.length ? undefined : null;
}

const talkStatusIsError = (state: ChatRealtimeState) =>
  state.realtimeTalk.snapshot.realtimeTalkStatus === "error";
const persistCameraPreference = (state: ChatRealtimeState, enabled: boolean) => {
  state.settings = patchSettings({ talkCameraAutoEnable: enabled });
};
const showCameraError = (state: ChatRealtimeState, error: unknown) => {
  state.realtimeTalk.update({
    realtimeTalkDetail: formatUiError(error),
    realtimeTalkCameraError: true,
  });
};
async function refreshCameraDevices(state: ChatRealtimeState, session: RealtimeTalkSession) {
  const result = await discoverRealtimeTalkCameras(() => false);
  if (state.realtimeTalk.snapshot.realtimeTalkSession === session) {
    state.realtimeTalk.update({ realtimeTalkCameraDevices: result.devices });
  }
}

export async function setRealtimeTalkCameraEnabled(
  state: ChatRealtimeState,
  enabled: boolean,
  options: { disableAutoEnableOnFailure?: boolean } = {},
) {
  const session = state.realtimeTalk.snapshot.realtimeTalkSession;
  if (
    !session ||
    !state.realtimeTalk.snapshot.realtimeTalkVideoCapable ||
    state.realtimeTalk.snapshot.realtimeTalkVideoPending ||
    talkStatusIsError(state)
  ) {
    return;
  }
  state.realtimeTalk.update({
    realtimeTalkVideoPending: true,
    realtimeTalkCameraError: false,
    realtimeTalkDetail: null,
  });
  if (!enabled) {
    persistCameraPreference(state, false);
  }
  try {
    if (enabled) {
      await session.switchCamera(loadSettings().realtimeTalkVideoDeviceId);
    }
    await session.setVideoEnabled(enabled);
  } catch (error) {
    if (state.realtimeTalk.snapshot.realtimeTalkSession !== session || talkStatusIsError(state)) {
      return;
    }
    if (options.disableAutoEnableOnFailure) {
      persistCameraPreference(state, false);
    }
    state.realtimeTalk.update({
      realtimeTalkVideoStream: null,
    });
    showCameraError(state, error);
  } finally {
    if (state.realtimeTalk.snapshot.realtimeTalkSession === session) {
      state.realtimeTalk.update({
        realtimeTalkVideoPending: false,
      });
    }
  }
}

export async function switchRealtimeTalkCamera(state: ChatRealtimeState) {
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
    if (state.realtimeTalk.snapshot.realtimeTalkSession === session && !talkStatusIsError(state)) {
      showCameraError(state, error);
    }
  } finally {
    if (state.realtimeTalk.snapshot.realtimeTalkSession === session) {
      state.realtimeTalk.update({
        realtimeTalkVideoPending: false,
      });
    }
  }
}

type RealtimeTalkStart = {
  client: GatewayBrowserClient;
  sessionKey: string;
  voiceController: RealtimeTalkVoiceSelection | null;
  useSystemDefault: boolean;
  voiceChange?: TalkVoiceChangeEvent;
  replacementTransport: ReturnType<RealtimeTalkSession["getTransport"]>;
  inputDeviceId?: string;
  videoDeviceId?: string;
  split?: SplitTalkOptions;
  playback: GatewaySpeechPlayback;
  autoEnableCamera: boolean;
  itemPrefix: string;
  orderOffset: number;
  stopRealtimeTalk: typeof stopChatRealtimeTalk;
  startRealtimeTalk: (
    useSystemDefault: boolean,
    voiceChange?: TalkVoiceChangeEvent,
  ) => Promise<RealtimeTalkSession | undefined>;
};

export async function startChatRealtimeSession(
  state: ChatRealtimeState,
  {
    client,
    sessionKey,
    voiceController: initialVoiceController,
    useSystemDefault,
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
    stopRealtimeTalk,
  }: RealtimeTalkStart,
): Promise<RealtimeTalkSession | undefined> {
  let voiceController = initialVoiceController;
  if (!voiceChange) {
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
        stopRealtimeTalk(state, { preserveConversation: true });
        state.realtimeTalk.update({
          realtimeTalkStatus: "error",
          realtimeTalkDetail: message,
        });
      },
    });
    voiceController = controller;
    state.realtimeTalk.update({ realtimeTalkVoiceController: controller });
  }
  let autoEnableCameraAttempted = false;
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
          void setRealtimeTalkCameraEnabled(state, true, { disableAutoEnableOnFailure: true });
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
            {
              ...entry,
              ...(entry.itemId === undefined
                ? {}
                : {
                    itemId: `${itemPrefix}${entry.itemId}`,
                    order: entry.order === undefined ? undefined : orderOffset + entry.order,
                  }),
              afterMessageId: latestSavedMessageId(state.chatMessages),
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
          persistCameraPreference(state, true);
          state.realtimeTalk.update({
            realtimeTalkDetail: null,
            realtimeTalkCameraError: false,
          });
          void refreshCameraDevices(state, session);
        }
      }),
      onVideoError: forCurrentSession((error) => {
        if (!talkStatusIsError(state)) {
          showCameraError(state, error);
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
    stopRealtimeTalk(state);
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
}
