/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import {
  createNativeDeviceSettingsCapability,
  type NativeDeviceSettingsCapability,
  type NativeDeviceSettingsSnapshot,
} from "../../app/native-device-settings.ts";
import { projectNativeDeviceSettings } from "../../lib/reactive/application-native.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createNativeDeviceSettingsSnapshot } from "../../test-helpers/native-device-settings.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { DeviceTalk } from "./talk-device.tsx";

const capabilities: NativeDeviceSettingsCapability[] = [];
afterEach(() => {
  capabilities.splice(0).forEach((capability) => capability.dispose());
  vi.unstubAllGlobals();
});

function installBridge(snapshot: NativeDeviceSettingsSnapshot | null = null) {
  const post = vi
    .fn<(message: { type: string }) => Promise<unknown>>()
    .mockResolvedValue(undefined);
  vi.stubGlobal("webkit", { messageHandlers: { openclawDeviceSettings: { postMessage: post } } });
  vi.stubGlobal("__OPENCLAW_NATIVE_DEVICE_SETTINGS__", snapshot);
  const capability = createNativeDeviceSettingsCapability()!;
  capabilities.push(capability);
  return { capability, post };
}

function publish(snapshot: unknown) {
  window.dispatchEvent(
    new CustomEvent("openclaw:native-device-settings-changed", { detail: snapshot }),
  );
}

function mountDevice(capability: NativeDeviceSettingsCapability) {
  const mounted = mountSolid(() => {
    const snapshot = projectNativeDeviceSettings(capability);
    return <DeviceTalk capability={capability} snapshot={snapshot.read()} />;
  });
  flush();
  return mounted;
}

it.each(["document", "event", "edit"])(
  "renders the first accepted native snapshot from %s",
  async (source) => {
    const snapshot = createNativeDeviceSettingsSnapshot();
    const { capability, post } = installBridge(source === "document" ? snapshot : null);
    const { container } = mountDevice(capability);
    if (source === "document") {
      expect(container.querySelector("input[type=checkbox]")).not.toBeNull();
    } else {
      expect(container.textContent).toContain("Loading");
      publish({ contract: 0 });
      flush();
      expect(container.querySelector("input[type=checkbox]")).toBeNull();
      if (source === "event") {
        publish(snapshot);
      } else {
        post.mockResolvedValueOnce(snapshot);
        capability.set("voice.wakeEnabled", false);
      }
    }
    await expect(capability.initialSnapshot).resolves.toEqual(snapshot);
    await waitForSolid(() => expect(container.textContent).toContain("Voice Wake"));
    expect(container.textContent).not.toContain("Loading");
    expect(post.mock.calls.filter(([message]) => message.type === "status")).toHaveLength(1);
  },
);

it("retires a pending snapshot without letting an old edit settle the replacement", async () => {
  const previous = installBridge();
  const reply = Promise.withResolvers<unknown>();
  previous.post.mockReturnValueOnce(reply.promise);
  previous.capability.set("voice.wakeEnabled", true);
  previous.capability.dispose();
  await expect(previous.capability.initialSnapshot).resolves.toBeNull();

  const current = installBridge();
  const { container } = mountDevice(current.capability);
  const settled = vi.fn();
  void current.capability.initialSnapshot.then(settled);
  reply.resolve(createNativeDeviceSettingsSnapshot());
  await reply.promise;
  flush();
  expect(settled).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Loading");
  expect(container.querySelector("input[type=checkbox]")).toBeNull();

  const snapshot = createNativeDeviceSettingsSnapshot();
  publish(snapshot);
  await waitForSolid(() => expect(container.textContent).toContain("Voice Wake"));
  expect(settled).toHaveBeenCalledWith(snapshot);
});
