import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { formatErrorMessage } from "../infra/errors.js";
import type { RuntimeLogger } from "../plugins/runtime/types.js";
import { convertPcmToMulaw8k } from "../talk/audio-codec.js";
import { decodeMeetingAudioBase64 } from "./audio-base64.js";
import { runMeetingBrowserAct } from "./browser-act-lock.js";
import type { MeetingBrowserAudioCaptureRequest } from "./browser-audio-capture-source.js";
import type { MeetingBrowserRequestCaller } from "./platform-adapter-contract.js";
import type { MeetingRealtimeAudioFormat } from "./realtime-audio-format.js";
import type { MeetingRealtimeAudioTransport } from "./realtime-audio-transport.js";

export async function createBrowserMeetingRealtimeAudioTransport(params: {
  nativeTransport: MeetingRealtimeAudioTransport;
  hasConfiguredInputCommand: boolean;
  callBrowser: MeetingBrowserRequestCaller;
  buildCaptureScript?: (request: MeetingBrowserAudioCaptureRequest) => string;
  meetingSessionId: string;
  meetingUrl: string;
  targetId?: string;
  audioFormat: MeetingRealtimeAudioFormat;
  logger: RuntimeLogger;
}): Promise<MeetingRealtimeAudioTransport> {
  const { buildCaptureScript, targetId } = params;
  if (params.hasConfiguredInputCommand || !buildCaptureScript) {
    return params.nativeTransport;
  }
  if (!targetId) {
    throw new Error("Meeting browser audio capture requires its tracked tab.");
  }
  const captureId = randomUUID();
  let stopped = false;
  let inputStarted = false;
  let fatal = false;
  let fatalHandler: (() => void) | undefined;
  let stopPromise: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const callCapture = (action: MeetingBrowserAudioCaptureRequest["action"]) =>
    runMeetingBrowserAct({
      deadline: Date.now() + 5_000,
      targetId,
      operation: async (timeoutMs) => {
        if (stopped && action !== "stop") {
          return { closed: true };
        }
        const response = await params.callBrowser({
          method: "POST",
          path: "/act",
          timeoutMs,
          body: {
            kind: "evaluate",
            targetId,
            fn: buildCaptureScript({
              action,
              captureId,
              meetingSessionId: params.meetingSessionId,
              meetingUrl: params.meetingUrl,
            }),
          },
        });
        const raw = asOptionalRecord(response)?.result;
        const result = typeof raw === "string" ? asOptionalRecord(JSON.parse(raw)) : undefined;
        if (!result || result.captureId !== captureId) {
          throw new Error("Meeting browser returned an invalid audio capture response.");
        }
        return result;
      },
    });
  const stop = () => {
    stopPromise ??= (async () => {
      stopped = true;
      clearTimeout(timer);
      await Promise.all([
        params.nativeTransport.stop(),
        callCapture("stop").catch((error: unknown) => {
          params.logger.warn(`Meeting browser audio cleanup failed: ${formatErrorMessage(error)}`);
        }),
      ]);
    })();
    return stopPromise;
  };
  const fail = (error?: unknown) => {
    if (stopped || fatal) {
      return;
    }
    fatal = true;
    if (error) {
      params.logger.warn(`Meeting browser audio capture failed: ${formatErrorMessage(error)}`);
    }
    void stop().catch((cleanupError: unknown) => {
      params.logger.warn(`Meeting audio cleanup failed: ${formatErrorMessage(cleanupError)}`);
    });
    fatalHandler?.();
  };
  params.nativeTransport.onFatal(() => fail());
  try {
    const result = await callCapture("start");
    if (stopped || result.isolated !== true) {
      throw new Error(
        "Meeting browser could not isolate remote playback from its virtual microphone.",
      );
    }
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    inputAudioIsolated: true,
    onFatal(handler) {
      fatalHandler = handler;
      if (fatal) {
        handler();
      }
    },
    startInput(onAudio) {
      if (inputStarted) {
        throw new Error("audio input transport already started");
      }
      inputStarted = true;
      // The native bus contains assistant injection. Keep it solely for waveform verification.
      params.nativeTransport.startInput(() => {});
      const pull = async () => {
        if (stopped) {
          return;
        }
        try {
          const result = await callCapture("pull");
          if (stopped) {
            return;
          }
          if (result.closed === true || result.isolated !== true) {
            fail(new Error("Meeting browser audio capture lost its session."));
            return;
          }
          if (typeof result.base64 === "string" && result.base64) {
            if (result.base64.length > 65_536) {
              throw new Error("Meeting browser audio exceeded its input buffer.");
            }
            const pcm = decodeMeetingAudioBase64(result.base64, "meeting browser audio");
            if (pcm.length % 2 !== 0) {
              throw new Error("Meeting browser returned incomplete PCM samples.");
            }
            const audio =
              params.audioFormat === "pcm16-24khz" ? pcm : convertPcmToMulaw8k(pcm, 24_000);
            onAudio(audio);
          }
          if (!stopped) {
            timer = setTimeout(() => void pull(), 50);
          }
        } catch (error) {
          fail(error);
        }
      };
      void pull();
    },
    beginOutput: () => params.nativeTransport.beginOutput?.(),
    writeOutput: (audio) =>
      stopped ? Promise.resolve() : params.nativeTransport.writeOutput(audio),
    clearOutput: () => (stopped ? Promise.resolve() : params.nativeTransport.clearOutput()),
    ...(params.nativeTransport.startBargeInMonitor
      ? {
          startBargeInMonitor: (handler: (audio: Buffer) => boolean) => {
            if (!stopped) {
              params.nativeTransport.startBargeInMonitor?.(handler);
            }
          },
        }
      : {}),
    getHealth: () => params.nativeTransport.getHealth?.() ?? {},
    stop,
    dispose: stop,
  };
}
