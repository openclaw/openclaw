import { createDeferredCore, type Deferred } from "../../../../src/shared/deferred.js";
import type { ApplicationContext } from "../../app/context.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  discoverRealtimeTalkCameras,
  discoverRealtimeTalkInputs,
  realtimeTalkDeviceIssueMessage,
} from "../chat/talk/input.ts";
import { switchActiveRealtimeTalkCameras } from "../chat/talk/session.ts";
import { createMediaDeviceState } from "./view-state.ts";

export function createMediaDevicePreferences(
  applySelection: (deviceId: string | undefined) => void,
  invalidate: () => void,
) {
  const devices = { microphone: createMediaDeviceState(), camera: createMediaDeviceState() };
  const device = devices.camera;
  let current: Deferred | null = null;
  let presentation = Promise.withResolvers<void>();
  function retire() {
    presentation.resolve();
    presentation = Promise.withResolvers<void>();
    for (const state of Object.values(devices)) {
      state.requestsPermission = false;
    }
  }
  const selectCamera = (deviceId: string) => {
    const retired = presentation.promise;
    // Retire superseded presentation even if the old hardware switch stays pending.
    current?.resolve();
    const selection = createDeferredCore();
    current = selection;
    const videoDeviceId = deviceId.trim() || undefined;
    device.selection = selection.promise;
    device.discovery = null;
    void selection.promise.catch(() => {});
    invalidate();
    void switchActiveRealtimeTalkCameras(videoDeviceId)
      .then(() => {
        if (current !== selection) {
          return;
        }
        // Persist only the latest camera accepted by the active Talk session.
        applySelection(videoDeviceId);
        selection.resolve();
      })
      .catch((error: unknown) => {
        if (current === selection) {
          device.selection = selection.promise;
          selection.reject(error);
          invalidate();
        }
      });
    // Navigation releases only presentation; the device retains its actual receipt.
    return Promise.race([selection.promise, retired]);
  };
  return {
    devices,
    selectCamera,
    retire,
    observeNavigation(router: Pick<ApplicationContext["router"], "getState" | "subscribe">) {
      // Intent arrives before Solid teardown, which can be parked by the action.
      return router.subscribe(() => {
        const state = router.getState();
        const target = state.pendingMatches[0] ?? state.matches[0];
        if (target?.routeId !== "appearance") {
          retire();
        }
      });
    },
  };
}

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
  device.selection = null;
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
      device.selection = null;
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
