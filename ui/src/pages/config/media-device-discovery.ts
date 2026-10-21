import { formatUiError } from "../../lib/format-error.ts";
import {
  discoverRealtimeTalkCameras,
  discoverRealtimeTalkInputs,
  realtimeTalkDeviceIssueMessage,
} from "../chat/talk/input.ts";
import type { createMediaDeviceState } from "./view-state.ts";

export function refreshMediaDevice(
  device: ReturnType<typeof createMediaDeviceState>,
  kind: "microphone" | "camera",
  requestPermission: boolean,
  invalidate: () => void,
) {
  if (device.activeDiscovery) {
    device.requestsPermission ||= requestPermission;
    return device.activeDiscovery;
  }
  device.requestsPermission = requestPermission;
  device.error = null;
  const discover = kind === "microphone" ? discoverRealtimeTalkInputs : discoverRealtimeTalkCameras;
  const request = discover(() => device.requestsPermission)
    .then((result) => {
      device.devices = result.devices;
      device.permissionRequired = result.permissionRequired;
      return result.issue
        ? realtimeTalkDeviceIssueMessage(
            result.issue,
            kind === "microphone" ? "audioinput" : "videoinput",
          )
        : null;
    }, formatUiError)
    .finally(() => {
      device.activeDiscovery = null;
      device.error = null;
      device.discovery = request;
      device.requestsPermission = false;
      invalidate();
    });
  // Admission stays synchronous; the retained receipt drives only status rendering.
  device.activeDiscovery = request;
  device.discovery = request;
  invalidate();
  return request;
}
