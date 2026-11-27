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

type RealtimeTalkDeviceDiscovery = {
  devices: RealtimeTalkInputDevice[];
  permissionRequired: boolean;
  issue: RealtimeTalkDeviceIssue | null;
};

export type RealtimeTalkDeviceKind = "audioinput" | "videoinput";

function normalizeDevices(
  devices: MediaDeviceInfo[],
  kind: RealtimeTalkDeviceKind,
): RealtimeTalkInputDevice[] {
  const normalized: RealtimeTalkInputDevice[] = [];
  const seen = new Set<string>();
  for (const device of devices) {
    const deviceId = device.deviceId.trim();
    // Chromium exposes a synthetic `default` alias. The picker already owns a
    // provider-neutral System default entry, so listing the alias duplicates it.
    if (device.kind !== kind || !deviceId || deviceId === "default" || seen.has(deviceId)) {
      continue;
    }
    seen.add(deviceId);
    normalized.push({
      deviceId,
      label:
        device.label.trim() ||
        t(
          kind === "audioinput"
            ? "chat.composer.microphoneFallback"
            : "chat.composer.cameraFallback",
          { number: String(normalized.length + 1) },
        ),
    });
  }
  return normalized;
}

function deviceDetailsHidden(devices: MediaDeviceInfo[], kind: RealtimeTalkDeviceKind): boolean {
  const inputs = devices.filter((device) => device.kind === kind);
  return inputs.length === 0 || inputs.some((device) => !device.deviceId || !device.label);
}

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

export async function discoverRealtimeTalkDevices(
  requestPermission: () => boolean,
  kind: RealtimeTalkDeviceKind,
): Promise<RealtimeTalkDeviceDiscovery> {
  const devices = globalThis.navigator?.mediaDevices;
  if (!devices?.enumerateDevices) {
    return { devices: [], permissionRequired: false, issue: "list-unsupported" };
  }
  const permissionRequestedAtStart = requestPermission();
  let entries: MediaDeviceInfo[];
  try {
    entries = await devices.enumerateDevices();
  } catch (error) {
    // Preserve a gesture's queued upgrade if passive enumeration failed. The
    // permission-bearing pass cannot recursively upgrade itself again.
    if (!permissionRequestedAtStart && requestPermission()) {
      return discoverRealtimeTalkDevices(requestPermission, kind);
    }
    return { devices: [], permissionRequired: false, issue: deviceIssueFromError(error) };
  }
  const permissionRequired = deviceDetailsHidden(entries, kind);
  // Permission intent belongs to the caller's live surface, not the earlier
  // enumeration. There is no asynchronous gap between this check and the probe.
  if (!permissionRequired || !devices.getUserMedia || !requestPermission()) {
    return { devices: normalizeDevices(entries, kind), permissionRequired, issue: null };
  }

  try {
    const probe = await devices.getUserMedia(
      kind === "audioinput" ? { audio: true } : { video: true },
    );
    probe.getTracks().forEach((track) => track.stop());
    entries = await devices.enumerateDevices();
    return {
      devices: normalizeDevices(entries, kind),
      permissionRequired: deviceDetailsHidden(entries, kind),
      issue: null,
    };
  } catch (error) {
    return {
      devices: normalizeDevices(entries, kind),
      permissionRequired,
      issue: deviceIssueFromError(error),
    };
  }
}
