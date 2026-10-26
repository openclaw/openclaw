/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import {
  createNativeDeviceSettingsCapability,
  type NativeDeviceSettingsCapability,
  type NativeDeviceSettingsSnapshot,
} from "../../app/native-device-settings.ts";
import { projectNativeDeviceSettings } from "../../lib/reactive/application-native.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { createNativeDeviceSettingsSnapshot } from "../../test-helpers/native-device-settings.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { DeviceTalk } from "./talk-device.tsx";
import { nativeVoice } from "./talk.test-support.tsx";

const capabilities: NativeDeviceSettingsCapability[] = [];
afterEach(() => {
  cleanupSolid();
  vi.restoreAllMocks();
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
  const retired = new Promise<void>(() => {});
  const mounted = mountSolid(() => {
    const snapshot = projectNativeDeviceSettings(capability);
    return (
      <DeviceTalk
        capability={capability}
        snapshot={snapshot.read()}
        presentationRetired={() => retired}
      />
    );
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
        await capability.set("voice.wakeEnabled", false);
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
  void previous.capability.set("voice.wakeEnabled", true);
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

it("keeps native controls editable and mounted through overlapping writes", async () => {
  const snapshot = createNativeDeviceSettingsSnapshot();
  snapshot.revision = 1;
  snapshot.voice.microphone.devices.push({ id: "usb", name: "USB Microphone" });
  const { capability, post } = installBridge(snapshot);
  const first = Promise.withResolvers<unknown>();
  const second = Promise.withResolvers<unknown>();
  const toggle = Promise.withResolvers<unknown>();
  post
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockReturnValueOnce(toggle.promise);
  const { container } = mountDevice(capability);
  const microphone = container.querySelector<HTMLSelectElement>('select[aria-label="Microphone"]')!;
  const wake = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  microphone.value = "builtin";
  microphone.dispatchEvent(new Event("change", { bubbles: true }));
  await waitForSolid(() => expect(container.textContent).toContain("Saving"));
  expect(microphone.value).toBe("builtin");
  expect(microphone.disabled).toBe(false);
  microphone.value = "usb";
  microphone.dispatchEvent(new Event("change", { bubbles: true }));
  await waitForSolid(() => expect(microphone.value).toBe("usb"));
  expect(post).toHaveBeenCalledWith({ type: "set", key: "voice.microphone", value: "usb" });

  const accepted = structuredClone(snapshot);
  accepted.revision = 3;
  accepted.voice.microphone.selectedId = "usb";
  second.resolve(accepted);
  await waitForSolid(() => {
    expect(capability.snapshot?.revision).toBe(3);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
  expect(microphone.value).toBe("usb");
  expect(container.querySelector('select[aria-label="Microphone"]')).toBe(microphone);

  const stale = structuredClone(snapshot);
  stale.revision = 2;
  stale.voice.microphone.selectedId = "builtin";
  first.resolve(stale);
  wake.click();
  await waitForSolid(() => expect(wake.checked).toBe(true));
  expect(wake.disabled).toBe(false);
  const withWake = structuredClone(accepted);
  withWake.revision = 4;
  withWake.voice.wakeEnabled = true;
  toggle.resolve(withWake);
  await waitForSolid(() => expect(container.textContent).not.toContain("Saving"));
  expect(microphone.value).toBe("usb");
  expect(wake.checked).toBe(true);
  expect(capability.snapshot?.revision).toBe(4);
});

it("shows rejected native edits and retries the desired value without replacing controls", async () => {
  const snapshot = createNativeDeviceSettingsSnapshot();
  const { capability, post } = installBridge(snapshot);
  const failed = Promise.withResolvers<unknown>();
  const retry = Promise.withResolvers<unknown>();
  post.mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise);
  const { container } = mountDevice(capability);
  const microphone = container.querySelector<HTMLSelectElement>('select[aria-label="Microphone"]')!;
  microphone.value = "builtin";
  microphone.dispatchEvent(new Event("change", { bubbles: true }));
  await waitForSolid(() => expect(container.textContent).toContain("Saving"));
  expect(microphone.value).toBe("builtin");
  failed.reject(new Error("Synthetic microphone unavailable"));
  await waitForSolid(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Synthetic microphone unavailable",
    ),
  );
  expect(microphone.value).toBe("");
  expect(container.querySelector('select[aria-label="Microphone"]')).toBe(microphone);
  container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
  await waitForSolid(() => {
    expect(microphone.value).toBe("builtin");
    expect(container.textContent).toContain("Saving");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
  expect(post).toHaveBeenLastCalledWith({ type: "set", key: "voice.microphone", value: "builtin" });
  const accepted = structuredClone(snapshot);
  accepted.voice.microphone.selectedId = "builtin";
  retry.resolve(accepted);
  await waitForSolid(() => expect(container.textContent).not.toContain("Saving"));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('select[aria-label="Microphone"]')).toBe(microphone);
  expect(microphone.value).toBe("builtin");
});

it("retains a rejected native language edit and retries it visibly", async () => {
  const snapshot = createNativeDeviceSettingsSnapshot();
  const { capability, post } = installBridge(snapshot);
  post.mockResolvedValue(snapshot);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { container: page } = mountDevice(capability);
  const failed = Promise.withResolvers<unknown>();
  post.mockReturnValueOnce(failed.promise);
  const primary = await waitForSolid(() => {
    const select = page.querySelector<HTMLSelectElement>('select[aria-label="Primary language"]');
    expect(select).not.toBeNull();
    return select!;
  });
  primary.value = "de-DE";
  primary.dispatchEvent(new Event("change"));
  failed.reject(new Error("Native language write unavailable"));
  await waitForSolid(() => {
    expect(page.querySelector('[role="alert"]')?.textContent).toContain(
      "Native language write unavailable",
    );
    expect(primary.value).toBe("de-DE");
  });
  expect(capability.snapshot?.voice.locale?.primary).toBe("en-US");
  const accepted = createNativeDeviceSettingsSnapshot();
  accepted.voice.locale.primary = "de-DE";
  post.mockResolvedValueOnce(accepted);
  page.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
  await waitForSolid(() => {
    expect(capability.snapshot?.voice.locale?.primary).toBe("de-DE");
    expect(primary.value).toBe("de-DE");
    expect(page.querySelector('[role="alert"]')).toBeNull();
  });
  expect(post).toHaveBeenCalledTimes(3);
  expect(post).toHaveBeenNthCalledWith(2, {
    type: "set",
    key: "voice.locale.primary",
    value: "de-DE",
  });
  expect(post).toHaveBeenNthCalledWith(3, {
    type: "set",
    key: "voice.locale.primary",
    value: "de-DE",
  });
});

it("preserves pending language additions across an older native acknowledgment and the next edit", async () => {
  const snapshot = createNativeDeviceSettingsSnapshot();
  snapshot.voice.locale.available.push(
    { id: "fr-FR", name: "French" },
    { id: "es-ES", name: "Spanish" },
    { id: "it-IT", name: "Italian" },
  );
  const { settings: nativeDeviceSettings, publish: publishSnapshot } = nativeVoice(snapshot);
  const completions: Array<() => void> = [];
  nativeDeviceSettings.set.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        completions.push(resolve);
      }),
  );
  const settle = (index: number, error?: Error) => {
    nativeDeviceSettings.set.mock.calls[index]?.[2]?.(error);
    completions[index]?.();
  };
  const { container: page } = mountDevice(nativeDeviceSettings);
  const add = (id: string) => {
    const select = page.querySelector<HTMLSelectElement>('select[aria-label="Add language…"]')!;
    select.value = id;
    select.dispatchEvent(new Event("change"));
  };
  add("de-DE");
  add("fr-FR");
  expect(nativeDeviceSettings.set).toHaveBeenLastCalledWith(
    "voice.locale.additional",
    ["de-DE", "fr-FR"],
    expect.any(Function),
  );
  flush();
  expect(page.querySelector('button[aria-label="Remove French"]')).not.toBeNull();
  snapshot.voice.locale.additional = ["de-DE"];
  settle(0);
  publishSnapshot();
  add("es-ES");
  expect(nativeDeviceSettings.set).toHaveBeenLastCalledWith(
    "voice.locale.additional",
    ["de-DE", "fr-FR", "es-ES"],
    expect.any(Function),
  );
  const primary = page.querySelector<HTMLSelectElement>('select[aria-label="Primary language"]')!;
  primary.value = "fr-FR";
  primary.dispatchEvent(new Event("change"));
  expect(nativeDeviceSettings.set).toHaveBeenCalledWith(
    "voice.locale.additional",
    ["de-DE", "es-ES"],
    expect.any(Function),
  );
  snapshot.voice.locale.additional = ["de-DE", "fr-FR"];
  settle(1);
  publishSnapshot();
  expect(primary.value).toBe("fr-FR");
  add("it-IT");
  expect(nativeDeviceSettings.set).toHaveBeenLastCalledWith(
    "voice.locale.additional",
    ["de-DE", "es-ES", "it-IT"],
    expect.any(Function),
  );
  settle(completions.length - 1, new Error("Native edit failed"));
  publishSnapshot();
  await waitForSolid(() => {
    expect(page.querySelector('[role="alert"]')?.textContent).toContain("Native edit failed");
    expect(page.querySelector('button[aria-label="Remove Spanish"]')).not.toBeNull();
    expect(page.querySelector('button[aria-label="Remove Italian"]')).not.toBeNull();
  });
  page.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
  expect(nativeDeviceSettings.set).toHaveBeenLastCalledWith(
    "voice.locale.additional",
    ["de-DE", "es-ES", "it-IT"],
    expect.any(Function),
  );
  completions.forEach((complete) => complete());
});
