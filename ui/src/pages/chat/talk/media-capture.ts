import { racePromiseWithAbortSignal } from "@openclaw/retry";
import { t } from "../../../i18n/index.ts";
import { UserFacingError } from "../../../lib/format-error.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import {
  deviceIssueFromError,
  mediaDeviceErrorName,
  realtimeTalkDeviceIssueMessage,
  type RealtimeTalkDeviceKind,
} from "./input.ts";

export function describeRealtimeTalkInputError(error: unknown): string {
  return realtimeTalkDeviceIssueMessage(deviceIssueFromError(error), "audioinput");
}

function realtimeTalkAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Realtime Talk input cancelled", "AbortError");
}

export class RealtimeTalkSelectedMicrophoneError extends Error {
  constructor() {
    super(t("chat.composer.selectedMicrophoneUnavailable"));
    this.name = "RealtimeTalkSelectedMicrophoneError";
  }
}

async function openRealtimeTalkMedia(
  kind: RealtimeTalkDeviceKind,
  selectedDeviceId: string | undefined,
  signal?: AbortSignal,
): Promise<MediaStream> {
  const devices = globalThis.navigator?.mediaDevices;
  if (!devices?.getUserMedia) {
    throw new Error(
      t(
        kind === "audioinput"
          ? "chat.composer.realtimeTalkRequiresMicrophone"
          : "chat.composer.cameraAccessFailed",
      ),
    );
  }
  const deviceId = selectedDeviceId?.trim();
  let acquisition: MediaStream;
  try {
    if (signal?.aborted) {
      throw realtimeTalkAbortReason(signal);
    }
    const request = devices.getUserMedia(
      kind === "audioinput"
        ? {
            audio: {
              autoGainControl: true,
              echoCancellation: true,
              noiseSuppression: true,
              ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
            },
          }
        : { video: deviceId ? { deviceId: { exact: deviceId } } : true },
    );
    try {
      acquisition = await racePromiseWithAbortSignal(request, signal, realtimeTalkAbortReason);
    } catch (error) {
      if (signal?.aborted) {
        // Browser permission prompts are not cancellable. Release any stream that
        // arrives after the lifecycle owner has already moved on.
        void request.then(
          (stream) => stream.getTracks().forEach((track) => track.stop()),
          () => undefined,
        );
        throw realtimeTalkAbortReason(signal);
      }
      throw error;
    }
  } catch (error) {
    if (signal?.aborted) {
      throw realtimeTalkAbortReason(signal);
    }
    const errorName = mediaDeviceErrorName(error);
    if (kind === "audioinput" && (!errorName || errorName === "AbortError")) {
      throw error;
    }
    // Exact selection is consent, including legacy WebKit failures. Only the
    // calling surface can offer an explicit choice to open a different input.
    if (deviceId && errorName === "OverconstrainedError") {
      throw kind === "audioinput"
        ? new RealtimeTalkSelectedMicrophoneError()
        : new Error(t("chat.composer.selectedCameraUnavailable"));
    }
    throw new UserFacingError(realtimeTalkDeviceIssueMessage(deviceIssueFromError(error), kind), {
      cause: error,
    });
  }
  if (signal?.aborted) {
    acquisition.getTracks().forEach((track) => track.stop());
    throw realtimeTalkAbortReason(signal);
  }
  return acquisition;
}

// Owns microphone acquisition; stop aborts track listeners and releases late permission results.
export class RealtimeTalkInputOwner {
  private controller: AbortController | null = null;
  private media: MediaStream | null = null;

  constructor(
    private onEnded: (detail: string) => void,
    private readonly onConnecting?: (detail?: string) => void,
  ) {}

  get stream(): MediaStream | null {
    return this.media;
  }

  requireStream(): MediaStream {
    const media = this.media;
    if (!media) {
      throw new Error(t("chat.composer.microphoneStopped"));
    }
    return media;
  }

  adopt(onEnded: (detail: string) => void): MediaStream {
    const media = this.requireStream();
    // Keep the same stream and listener across the candidate-to-transport handoff.
    this.onEnded = onEnded;
    return media;
  }

  async open(inputDeviceId: string | undefined): Promise<MediaStream> {
    this.stop();
    const controller = new AbortController();
    this.controller = controller;
    try {
      this.onConnecting?.(t("chat.composer.microphoneAccessPending"));
      const media = await openRealtimeTalkMedia("audioinput", inputDeviceId, controller.signal);
      if (controller.signal.aborted) {
        media.getTracks().forEach((track) => track.stop());
        throw realtimeTalkAbortReason(controller.signal);
      }
      this.media = media;
      const onEnded = () => {
        // A queued event from a retired microphone must not end its replacement.
        if (this.controller !== controller) {
          return;
        }
        this.stop();
        this.onEnded(t("chat.composer.microphoneStopped"));
      };
      for (const track of media.getTracks()) {
        listen(track, "ended", onEnded, { signal: controller.signal });
      }
      // Only the current, successful acquisition advances the visible startup phase.
      // Cancellation must not overwrite idle or a replacement's microphone prompt.
      this.onConnecting?.();
      return media;
    } catch (error) {
      if (this.controller === controller) {
        this.stop();
      }
      throw error;
    }
  }

  stop(): void {
    const controller = this.controller;
    const media = this.media;
    this.controller = null;
    this.media = null;
    // Abort removes only this acquisition's listeners before releasing tracks,
    // keeping normal stop quiet without disturbing other consumers' listeners.
    controller?.abort();
    media?.getTracks().forEach((track) => track.stop());
  }
}

export async function openRealtimeTalkCamera(
  videoDeviceId: string | undefined,
  options: { signal?: AbortSignal } = {},
): Promise<MediaStream> {
  return openRealtimeTalkMedia("videoinput", videoDeviceId, options.signal);
}
