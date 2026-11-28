import { t } from "../../../i18n/index.ts";
import {
  deviceIssueFromError,
  type RealtimeTalkDeviceIssue,
  type RealtimeTalkDeviceKind,
  type RealtimeTalkInputDevice,
} from "./input.ts";

type RealtimeTalkDeviceDiscovery = {
  devices: RealtimeTalkInputDevice[];
  permissionRequired: boolean;
  issue: RealtimeTalkDeviceIssue | null;
};

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

async function discoverRealtimeTalkDevices(
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

export async function discoverRealtimeTalkInputs(
  requestPermission: () => boolean,
): Promise<RealtimeTalkDeviceDiscovery> {
  return discoverRealtimeTalkDevices(requestPermission, "audioinput");
}

export async function discoverRealtimeTalkCameras(
  requestPermission: () => boolean,
): Promise<RealtimeTalkDeviceDiscovery> {
  return discoverRealtimeTalkDevices(requestPermission, "videoinput");
}
