/* @vitest-environment jsdom */
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type { NodePermissionRequest } from "../../../../../packages/gateway-protocol/src/node-permissions.js";
import { createDeferred } from "../../../../../test/helpers/promise.js";
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

async function mountPermissionCard(
  request: NodePermissionRequest,
  onRetry?: (message: string) => void,
  context?: ApplicationContext,
) {
  const container = document.createElement("div");
  document.body.append(container);
  const view = mountSolid(() => <ChatPermissionCard request={request} onRetry={onRetry} />, {
    container,
    wrapper: context ? createSolidApplicationContextProvider(context).wrapper : undefined,
  });
  onTestFinished(async () => {
    view.unmount();
    container.remove();
    await Promise.resolve();
  });
  flush();
  return view;
}

async function fixture(state: NodePermissionRequest["state"], ids = ["screenRecording"]) {
  const snapshot = createNativeDeviceSettingsSnapshot();
  snapshot.device.nodeId = "node-mac";
  snapshot.revision = 1;
  snapshot.permissions.entries = ids
    .filter((id) => id !== "computerControl" && id !== "cameraEnabled")
    .map((id) => ({
      // SAFETY: capability toggles are excluded; the remaining scenarios use native permission ids.
      id: id as "screenRecording" | "accessibility" | "camera" | "location",
      status:
        state === "not-determined" ? "notDetermined" : state === "denied" ? "denied" : "granted",
      state,
    }));
  if (ids.includes("computerControl")) {
    snapshot.capabilities.computerControlEnabled = false;
  }
  const post = vi.fn<(message: { type: string }) => Promise<unknown>>().mockResolvedValue(snapshot);
  vi.stubGlobal("webkit", { messageHandlers: { openclawDeviceSettings: { postMessage: post } } });
  vi.stubGlobal("__OPENCLAW_NATIVE_DEVICE_SETTINGS__", snapshot);
  capability = createNativeDeviceSettingsCapability();
  // SAFETY: the leaf consumes only nativeDeviceSettings; no other application owner is used.
  const context = { nativeDeviceSettings: capability } as ApplicationContext;
  const request: NodePermissionRequest = {
    nodeId: "node-mac",
    nodeName: "Example Mac",
    command: "screen.capture",
    capabilities: ids,
    state,
  };
  const retry = vi.fn();
  const view = await mountPermissionCard(request, retry, context);
  const publish = () => {
    snapshot.revision = (snapshot.revision ?? 0) + 1;
    window.dispatchEvent(
      new CustomEvent("openclaw:native-device-settings-changed", { detail: snapshot }),
    );
    flush();
  };
  return {
    view,
    post,
    retry,
    request,
    snapshot,
    publish,
    async resolve(label: string, capabilities = ids, nextState = state) {
      const button = view.getByRole("button", { name: label });
      button.click();
      await waitForSolid(() => {
        expect(post).toHaveBeenCalledWith({
          type: "resolve-permission",
          request: { ...request, capabilities, state: nextState },
        });
        expect(button.hasAttribute("disabled")).toBe(false);
      });
      expect(view.queryByRole("button", { name: "Try again" })).toBeNull();
    },
  };
}

it("keeps a multi-permission request blocked until both the toggle and OS grants are effective", async () => {
  const f = await fixture("disabled-in-openclaw", [
    "computerControl",
    "accessibility",
    "screenRecording",
  ]);
  f.snapshot.permissions.entries = [
    { id: "accessibility", status: "notDetermined" },
    { id: "screenRecording", status: "notDetermined" },
  ];
  f.publish();
  await f.resolve("Enable Computer Control", ["computerControl"]);
  expect(
    f.view.getByText("Then grant the remaining permissions: Accessibility, Screen Recording."),
  ).toBeTruthy();
  f.snapshot.capabilities.computerControlEnabled = true;
  f.publish();
  await f.resolve(
    "Grant Accessibility, Screen Recording",
    ["accessibility", "screenRecording"],
    "not-determined",
  );
  expect(f.view.queryByText(/Then grant the remaining permissions/)).toBeNull();
  f.snapshot.permissions.entries = [
    { id: "accessibility", status: "granted", state: "stale-grant" },
    { id: "screenRecording", status: "granted", state: "restart-required" },
  ];
  f.publish();
  await f.resolve("Open System Settings", ["accessibility"], "stale-grant");
  expect(f.view.queryByRole("button", { name: "Try again" })).toBeNull();
  f.snapshot.permissions.entries[0] = { id: "accessibility", status: "granted" };
  f.publish();
  await f.resolve("Relaunch OpenClaw", ["screenRecording"], "restart-required");
  f.snapshot.permissions.entries = [
    { id: "accessibility", status: "granted" },
    { id: "screenRecording", status: "granted" },
  ];
  f.publish();
  f.view.getByRole("button", { name: "Try again" }).click();
  expect(f.retry).toHaveBeenCalledExactlyOnceWith(
    "I granted Computer Control, Accessibility, Screen Recording, try again.",
  );
});

it("does not treat camera and location OS grants as enabling their OpenClaw toggles", async () => {
  const f = await fixture("disabled-in-openclaw", ["cameraEnabled", "camera", "location"]);
  f.snapshot.permissions.entries = [
    { id: "camera", status: "granted" },
    { id: "location", status: "granted" },
  ];
  f.snapshot.capabilities.cameraEnabled = false;
  f.snapshot.permissions.location.mode = "off";
  f.publish();
  expect(f.view.queryByRole("button", { name: "Try again" })).toBeNull();
});

it("opens Settings for denied Location while its OpenClaw mode is off", async () => {
  const f = await fixture("disabled-in-openclaw", ["location"]);
  f.snapshot.permissions.location.mode = "off";
  f.snapshot.permissions.entries = [{ id: "location", status: "denied", state: "denied" }];
  f.publish();
  await f.resolve("Open System Settings", ["location"], "denied");
  f.snapshot.permissions.entries = [{ id: "location", status: "granted" }];
  f.publish();
  expect(f.view.getByRole("button", { name: "Enable Location" })).toBeTruthy();
  f.snapshot.permissions.location.mode = "whileUsing";
  f.publish();
  expect(f.view.getByRole("button", { name: "Try again" })).toBeTruthy();
});

it.each([false, true])(
  "separates camera enumeration enablement from capture authorization (capture=%s)",
  async (capture) => {
    const f = await fixture("disabled-in-openclaw", [
      "cameraEnabled",
      ...(capture ? ["camera"] : []),
    ]);
    f.snapshot.capabilities.cameraEnabled = false;
    f.snapshot.permissions.entries = [{ id: "camera", status: "notDetermined" }];
    f.publish();
    expect(f.view.queryByRole("button", { name: "Try again" })).toBeNull();
    f.snapshot.capabilities.cameraEnabled = true;
    f.publish();
    expect(Boolean(f.view.queryByRole("button", { name: "Try again" }))).toBe(!capture);
    if (capture) {
      f.snapshot.permissions.entries = [{ id: "camera", status: "granted" }];
      f.publish();
      expect(f.view.getByRole("button", { name: "Try again" })).toBeTruthy();
    }
  },
);

it("shows app guidance for another node and rejects a stale local node action", async () => {
  const f = await fixture("denied");
  const resolve = capability!.resolvePermission!;
  f.snapshot.device.nodeId = "other-node";
  f.publish();
  expect(f.view.getByText(/Settings → This Mac → Permissions/)).toBeTruthy();
  expect(f.view.queryByRole("button")).toBeNull();
  await expect(resolve(f.request)).rejects.toThrow("another device");
  expect(f.post).not.toHaveBeenCalledWith(expect.objectContaining({ type: "resolve-permission" }));
});

it("shows grant failures, clears them during retry, and waits for observed access", async () => {
  const f = await fixture("denied");
  const failed = createDeferred();
  const retried = createDeferred();
  onTestFinished(() => {
    failed.resolve();
    retried.resolve();
  });
  f.post.mockImplementationOnce(() => failed.promise);
  const button = f.view.getByRole<HTMLButtonElement>("button", { name: "Open System Settings" });
  button.click();
  await waitForSolid(() => expect(button.disabled).toBe(true));
  expect(f.view.queryByRole("alert")).toBeNull();
  expect(f.view.queryByRole("button", { name: "Try again" })).toBeNull();
  failed.reject(new Error("Permission request was cancelled"));
  await waitForSolid(() =>
    expect(f.view.getByRole("alert").textContent).toBe("Permission request was cancelled"),
  );
  expect(button.disabled).toBe(false);
  f.post.mockImplementationOnce(() => retried.promise);
  button.click();
  await waitForSolid(() => expect(button.disabled).toBe(true));
  expect(f.view.queryByRole("alert")).toBeNull();
  retried.resolve();
  await waitForSolid(() => expect(button.disabled).toBe(false));
  expect(f.view.queryByRole("alert")).toBeNull();
  expect(f.view.queryByRole("button", { name: "Try again" })).toBeNull();
  f.snapshot.permissions.entries = [{ id: "screenRecording", status: "granted" }];
  f.publish();
  f.view.getByRole("button", { name: "Try again" }).click();
  expect(f.retry).toHaveBeenCalledExactlyOnceWith("I granted Screen Recording, try again.");
});

it.each(
  (["denied", "restart-required", "granted"] as const).flatMap((outcome) =>
    [false, true].map((reject) => ({ outcome, reject })),
  ),
)(
  "refreshes the card to $outcome after a native grant attempt (reject=$reject)",
  async ({ outcome, reject }) => {
    const f = await fixture("not-determined");
    f.post.mockImplementation(async (message) => {
      if (message.type === "resolve-permission") {
        f.snapshot.permissions.entries = [
          outcome === "granted"
            ? { id: "screenRecording", status: "granted" }
            : { id: "screenRecording", status: "denied", state: outcome },
        ];
        if (reject) {
          throw new Error("Native grant request ended");
        }
        return null;
      }
      f.publish();
      return f.snapshot;
    });
    f.view.getByRole("button", { name: "Grant Screen Recording" }).click();
    await waitForSolid(() => {
      if (outcome === "granted") {
        expect(f.view.getByRole("button", { name: "Try again" })).toBeTruthy();
      } else if (outcome === "restart-required") {
        expect(f.view.getByRole("button", { name: "Relaunch OpenClaw" })).toBeTruthy();
      } else {
        expect(f.view.getByRole("button", { name: "Open System Settings" })).toBeTruthy();
      }
    });
  },
);

it("shows the Mac app destination in a browser without a native capability", async () => {
  const view = await mountPermissionCard({
    nodeId: "remote",
    command: "screen.capture",
    capabilities: ["screenRecording"],
    state: "denied",
  });
  expect(view.getByText(/Settings → This Mac → Permissions/)).toBeTruthy();
  expect(view.queryByRole("button")).toBeNull();
});
