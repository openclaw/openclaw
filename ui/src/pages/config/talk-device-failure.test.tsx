/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { createNativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import { projectNativeDeviceSettings } from "../../lib/reactive/application-native.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { createNativeDeviceSettingsSnapshot } from "../../test-helpers/native-device-settings.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { DeviceTalk } from "./talk-device.tsx";
import { nativeVoice } from "./talk.test-support.tsx";

afterEach(cleanupSolid);

it("retains a rejected native language edit and retries it visibly", async () => {
  const snapshot = createNativeDeviceSettingsSnapshot();
  const post = vi.fn<(message: unknown) => Promise<unknown>>().mockResolvedValue(snapshot);
  vi.stubGlobal("webkit", {
    messageHandlers: { openclawDeviceSettings: { postMessage: post } },
  });
  vi.stubGlobal("__OPENCLAW_NATIVE_DEVICE_SETTINGS__", snapshot);
  const capability = createNativeDeviceSettingsCapability()!;
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const retired = new Promise<void>(() => {});
  const view = mountSolid(() => {
    const device = projectNativeDeviceSettings(capability);
    return (
      <DeviceTalk
        capability={capability}
        snapshot={device.read()}
        presentationRetired={() => retired}
      />
    );
  });
  const page = view.container;
  const failed = Promise.withResolvers<unknown>();
  post.mockReturnValueOnce(failed.promise);
  try {
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
  } finally {
    view.unmount();
    capability.dispose();
    warning.mockRestore();
    vi.unstubAllGlobals();
  }
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
  const retired = new Promise<void>(() => {});
  const { container: page } = mountSolid(() => {
    const device = projectNativeDeviceSettings(nativeDeviceSettings);
    return (
      <DeviceTalk
        capability={nativeDeviceSettings}
        snapshot={device.read()}
        presentationRetired={() => retired}
      />
    );
  });
  flush();
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
