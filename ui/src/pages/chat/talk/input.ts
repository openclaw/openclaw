import { t } from "../../../i18n/index.ts";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { listen } from "../../../lib/reactive/listener.ts";

registerChatComposerEnglish();

export type RealtimeTalkInputDevice = {
  deviceId: string;
  label: string;
};

export type RealtimeTalkCameraDevice = RealtimeTalkInputDevice;

// Discovery owns failure reasons; each surface owns their presentation.
const deviceIssueMessageKeys = {
  "list-unsupported": [
    "chat.composer.microphoneListUnsupported",
    "chat.composer.cameraListUnsupported",
  ],
  "none-found": ["chat.composer.microphoneNoneFound", "chat.composer.cameraNoneFound"],
  "permission-blocked": [
    "chat.composer.microphonePermissionBlocked",
    "chat.composer.cameraPermissionBlocked",
  ],
  busy: ["chat.composer.microphoneBusy", "chat.composer.cameraBusy"],
  "page-inactive": ["chat.composer.microphonePageInactive", "chat.composer.cameraPageInactive"],
  failed: ["chat.composer.microphoneAccessFailed", "chat.composer.cameraAccessFailed"],
} as const;

export type RealtimeTalkDeviceIssue = keyof typeof deviceIssueMessageKeys;

export type RealtimeTalkDeviceKind = "audioinput" | "videoinput";

const deviceIssueByMediaErrorName = new Map<string, RealtimeTalkDeviceIssue>([
  ["NotAllowedError", "permission-blocked"],
  ["NotFoundError", "none-found"],
  ["NotReadableError", "busy"],
  ["InvalidStateError", "page-inactive"],
]);

export function mediaDeviceErrorName(error: unknown): string | undefined {
  // WebKit shipped OverconstrainedError as Error instead of DOMException.
  if (error instanceof DOMException) {
    return error.name;
  }
  return error instanceof Error && error.name === "OverconstrainedError" ? error.name : undefined;
}

export function deviceIssueFromError(error: unknown): RealtimeTalkDeviceIssue {
  return deviceIssueByMediaErrorName.get(mediaDeviceErrorName(error) ?? "") ?? "failed";
}

export function realtimeTalkDeviceIssueMessage(
  issue: RealtimeTalkDeviceIssue,
  kind: RealtimeTalkDeviceKind,
): string {
  const [microphoneKey, cameraKey] = deviceIssueMessageKeys[issue];
  return t(kind === "audioinput" ? microphoneKey : cameraKey);
}

/** Browser microphone access problems are recoverable in place, so they warn rather than fail. */
export function isRealtimeTalkMicrophoneIssueMessage(detail: string): boolean {
  return Object.values(deviceIssueMessageKeys).some(
    ([microphoneKey]) => t(microphoneKey) === detail,
  );
}

// The picker owns the subscription and releases it when its surface closes.
export function observeRealtimeTalkDevices(onChange: () => void): () => void {
  const devices = globalThis.navigator?.mediaDevices;
  if (!devices?.addEventListener) {
    return () => undefined;
  }
  return listen(devices, "devicechange", onChange);
}

export function describeRealtimeTalkInputError(error: unknown): string {
  return realtimeTalkDeviceIssueMessage(deviceIssueFromError(error), "audioinput");
}
