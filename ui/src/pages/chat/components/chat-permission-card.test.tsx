/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import {
  NODE_PERMISSION_STATES,
  type NodePermissionRequest,
} from "../../../../../packages/gateway-protocol/src/node-permissions.js";
import type { ApplicationContext } from "../../../app/context.ts";
import {
  createNativeDeviceSettingsCapability,
  type NativeDeviceSettingsCapability,
} from "../../../app/native-device-settings.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createNativeDeviceSettingsSnapshot } from "../../../test-helpers/native-device-settings.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatPermissionCard } from "./chat-permission-card.tsx";

let capability: NativeDeviceSettingsCapability | null;
afterEach(() => {
  capability?.dispose();
  capability = null;
  vi.unstubAllGlobals();
});

function fixture(state: NodePermissionRequest["state"], ids = ["screenRecording"]) {
  const snapshot = createNativeDeviceSettingsSnapshot();
  snapshot.device.nodeId = "node-mac";
  snapshot.revision = 1;
  snapshot.permissions.entries = ids
    .filter((id) => id !== "computerControl")
    .map((id) => ({
      // SAFETY: scenarios use native permission ids; computerControl is a capability toggle.
      id: id as "screenRecording" | "accessibility" | "camera" | "location",
      status:
        state === "not-determined" ? "notDetermined" : state === "denied" ? "denied" : "granted",
      state,
    }));
  if (ids.includes("computerControl")) snapshot.capabilities.computerControlEnabled = false;
  const post = vi.fn<(message: unknown) => Promise<unknown>>().mockResolvedValue(snapshot);
  vi.stubGlobal("webkit", { messageHandlers: { openclawDeviceSettings: { postMessage: post } } });
  vi.stubGlobal("__OPENCLAW_NATIVE_DEVICE_SETTINGS__", snapshot);
  capability = createNativeDeviceSettingsCapability();
  // SAFETY: the leaf consumes only nativeDeviceSettings; no other application owner is used.
  const context = { nativeDeviceSettings: capability } as ApplicationContext;
  const provider = createSolidApplicationContextProvider(context);
  const request: NodePermissionRequest = {
    nodeId: "node-mac",
    nodeName: "Example Mac",
    command: "screen.capture",
    capabilities: ids,
    state,
  };
  const retry = vi.fn();
  const view = mountSolid(() => <ChatPermissionCard request={request} onRetry={retry} />, {
    wrapper: provider.wrapper,
  });
  return {
    view,
    post,
    retry,
    request,
    snapshot,
    publish() {
      snapshot.revision = (snapshot.revision ?? 0) + 1;
      window.dispatchEvent(
        new CustomEvent("openclaw:native-device-settings-changed", { detail: snapshot }),
      );
      flush();
    },
  };
}

it.each(NODE_PERMISSION_STATES)(
  "routes %s through the native owner and waits for observed access",
  async (state) => {
    const toggle = state === "disabled-in-openclaw";
    const name = toggle ? "Computer Control" : "Screen Recording";
    const f = fixture(state, toggle ? ["computerControl"] : ["screenRecording"]);
    const button = f.view.getByRole("button", {
      name: state === "restart-required" ? "Relaunch OpenClaw" : `Grant ${name}`,
    });
    button.click();
    await waitForSolid(() =>
      expect(f.post).toHaveBeenCalledWith({ type: "resolve-permission", request: f.request }),
    );
    expect(f.view.queryByRole("button", { name: "Try again" })).toBeNull();
    f.snapshot.permissions.entries = [{ id: "screenRecording", status: "granted" }];
    f.snapshot.capabilities.computerControlEnabled = true;
    f.publish();
    f.view.getByRole("button", { name: "Try again" }).click();
    expect(f.retry).toHaveBeenCalledExactlyOnceWith(`I granted ${name}, try again.`);
  },
);

it("keeps a multi-permission request blocked until both the toggle and OS grants are effective", async () => {
  const f = fixture("disabled-in-openclaw", [
    "computerControl",
    "accessibility",
    "screenRecording",
  ]);
  f.snapshot.capabilities.computerControlEnabled = true;
  f.snapshot.permissions.entries = [
    { id: "accessibility", status: "granted", state: "stale-grant" },
    { id: "screenRecording", status: "granted", state: "restart-required" },
  ];
  f.publish();
  f.view
    .getByRole("button", { name: "Grant Computer Control, Accessibility, Screen Recording" })
    .click();
  await waitForSolid(() =>
    expect(f.post).toHaveBeenCalledWith({
      type: "resolve-permission",
      request: {
        ...f.request,
        capabilities: ["accessibility", "screenRecording"],
        state: "stale-grant",
      },
    }),
  );
  expect(f.view.queryByRole("button", { name: "Try again" })).toBeNull();
  f.snapshot.permissions.entries = [
    { id: "accessibility", status: "granted" },
    { id: "screenRecording", status: "granted" },
  ];
  f.publish();
  expect(f.view.getByRole("button", { name: "Try again" })).toBeTruthy();
});

it("does not treat camera and location OS grants as enabling their OpenClaw toggles", () => {
  const f = fixture("disabled-in-openclaw", ["camera", "location"]);
  f.snapshot.permissions.entries = [
    { id: "camera", status: "granted" },
    { id: "location", status: "granted" },
  ];
  f.snapshot.capabilities.cameraEnabled = false;
  f.snapshot.permissions.location.mode = "off";
  f.publish();
  expect(f.view.queryByRole("button", { name: "Try again" })).toBeNull();
});

it("shows app guidance for another node and rejects a stale local node action", async () => {
  const f = fixture("denied");
  const resolve = capability!.resolvePermission!;
  f.snapshot.device.nodeId = "other-node";
  f.publish();
  expect(f.view.getByText(/Settings → This Mac → Permissions/)).toBeTruthy();
  expect(f.view.queryByRole("button")).toBeNull();
  await expect(resolve(f.request)).rejects.toThrow("another device");
  expect(f.post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "resolve-permission" }));
});

it("shows grant failures and never claims success", async () => {
  const f = fixture("denied");
  f.post.mockRejectedValueOnce(new Error("Permission request was cancelled"));
  f.view.getByRole("button", { name: "Grant Screen Recording" }).click();
  await waitForSolid(() =>
    expect(f.view.getByRole("alert").textContent).toBe("Permission request was cancelled"),
  );
  expect(f.view.queryByRole("button", { name: "Try again" })).toBeNull();
});

it("shows the Mac app destination in a browser without a native capability", () => {
  const view = mountSolid(() => (
    <ChatPermissionCard
      request={{
        nodeId: "remote",
        command: "screen.capture",
        capabilities: ["screenRecording"],
        state: "denied",
      }}
    />
  ));
  expect(view.getByText(/Settings → This Mac → Permissions/)).toBeTruthy();
  expect(view.queryByRole("button")).toBeNull();
});
