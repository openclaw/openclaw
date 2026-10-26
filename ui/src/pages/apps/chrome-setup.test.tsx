import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext } from "../../app/context.ts";
import type { NativeChromeExtensionSetupAction as Action } from "../../app/native-chrome-setup.ts";
import { createNativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import { i18n } from "../../i18n/index.ts";
import { createChromeExtensionSetupResult } from "../../test-helpers/chrome-extension-setup.ts";
/* @vitest-environment jsdom */
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createNativeDeviceSettingsSnapshot } from "../../test-helpers/native-device-settings.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush } from "../../test-helpers/solid-settle.ts";
import { Apps } from "./view.tsx";

const result = createChromeExtensionSetupResult;
const connected = {
  action: "verify",
  phase: "ready",
  connection: { state: "connected" },
  nextAction: "none",
} as const;
const labels = {
  install: "Set up Chrome on this device",
  inspect: "Refresh setup status",
  verify: "Verify connection",
};
const capabilities = new Set<NonNullable<ApplicationContext["nativeDeviceSettings"]>>();
function nativeBridge(
  postMessage: (message: { type: string; action?: Action }) => Promise<unknown>,
  snapshot = createNativeDeviceSettingsSnapshot(),
) {
  vi.stubGlobal("__OPENCLAW_NATIVE_DEVICE_SETTINGS__", snapshot);
  vi.stubGlobal("webkit", {
    messageHandlers: { openclawDeviceSettings: { postMessage } },
  });
  const capability = createNativeDeviceSettingsCapability()!;
  capabilities.add(capability);
  return capability;
}
function bridge(postMessage: (message: { action: Action }) => Promise<unknown>) {
  const snapshot = createNativeDeviceSettingsSnapshot();
  return nativeBridge(
    (message) =>
      message.type === "chrome-extension-setup" && message.action
        ? postMessage({ action: message.action })
        : Promise.resolve(snapshot),
    snapshot,
  );
}
function mount(capability: ApplicationContext["nativeDeviceSettings"] = null) {
  const { wrapper } = createSolidApplicationContextProvider({
    nativeDeviceSettings: capability,
  } as ApplicationContext);
  const { container, unmount } = mountSolid(() => <Apps onNavigate={vi.fn()} />, { wrapper });
  flush();
  const setup = container.querySelector<HTMLElement>("openclaw-native-chrome-setup")!;
  return { setup, card: setup.closest(".apps-card")!, unmount, capability };
}
const buttons = (setup: HTMLElement) => [...setup.querySelectorAll("button")];
function click(setup: HTMLElement, label: string) {
  const button = buttons(setup).find((el) => el.textContent?.trim() === label);
  expect(button).toBeDefined();
  button!.click();
}
const expectText = (setup: HTMLElement, text: string) =>
  vi.waitFor(() => expect(setup.textContent).toContain(text));
async function idle(setup: HTMLElement) {
  flush();
  await vi.waitFor(() => expect(setup.querySelector("button")!.disabled).toBe(false));
}
beforeEach(() => i18n.setLocale("en"));
afterEach(() => {
  for (const capability of capabilities) {
    capability.dispose();
  }
  capabilities.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Apps local Chrome setup", () => {
  it("uses explicit native actions through the device-settings context", async () => {
    const post = vi.fn(async ({ action }: { action: Action }) =>
      result({
        action,
        ...(action === "verify" ? connected : {}),
      }),
    );
    const { setup, card } = mount(bridge(post));
    window.dispatchEvent(new Event("focus"));
    expect(post).not.toHaveBeenCalled();
    expect(card.textContent).toContain("This does not install on a remote Gateway");
    click(setup, "Refresh setup status");
    await expectText(setup, "Setup required on this device.");
    expect(post.mock.calls).toEqual([[{ action: "inspect" }]]);
    click(setup, "Set up Chrome on this device");
    await idle(setup);
    click(setup, "Verify connection");
    await expectText(setup, "Extension connected on this device.");
    for (const text of ["Example Mac", "chrome", "18792"]) {
      expect(setup.textContent).toContain(text);
    }
    expect(setup.textContent).toContain("does not mean eligible tabs");
    expect(post.mock.calls).toEqual(["inspect", "install", "verify"].map((action) => [{ action }]));
  });
  it("offers no native actions in an ordinary browser", () => {
    const { setup } = mount();
    expect(setup.querySelector("button")).toBeNull();
  });
  it("blocks duplicate setup while pending and recovers after a rejected request", async () => {
    const pending = createDeferred<unknown>();
    const retry = createDeferred<unknown>();
    const post = vi.fn().mockReturnValueOnce(pending.promise).mockReturnValueOnce(retry.promise);
    const { setup } = mount(bridge(post));
    click(setup, labels.inspect);
    click(setup, labels.inspect);
    expect(post).toHaveBeenCalledExactlyOnceWith({ action: "inspect" });
    flush();
    expect(buttons(setup).every((button) => button.disabled)).toBe(true);
    expect(setup.textContent).toContain("Working on this device…");

    pending.reject(new Error("Native setup unavailable"));
    await expectText(setup, "Setup could not finish");
    await idle(setup);
    click(setup, labels.verify);
    flush();
    expect(setup.textContent).toContain("Working on this device…");
    expect(setup.textContent).not.toContain("Setup could not finish");
    expect(buttons(setup).every((button) => button.disabled)).toBe(true);
    retry.resolve(result(connected));
    await expectText(setup, "Extension connected on this device.");
    await idle(setup);
    expect(setup.textContent).not.toContain("Setup could not finish");
  });
  it.each([{ actions: [] }, { actions: ["inspect"] }] as const)(
    "offers only $actions",
    ({ actions }) => {
      const snapshot = createNativeDeviceSettingsSnapshot();
      snapshot.browser.chromeSetupActions = [...actions];
      const { setup } = mount(nativeBridge(async () => snapshot, snapshot));
      expect(buttons(setup).map((button) => button.textContent?.trim())).toEqual(
        actions.map((action) => labels[action]),
      );
    },
  );
  it("uses the released legacy install without claiming a connection", async () => {
    const snapshot = createNativeDeviceSettingsSnapshot();
    delete snapshot.browser.chromeSetupActions;
    const post = vi.fn(async (message: { type: string }) =>
      message.type === "install-chrome-extension"
        ? { nativeHostRegistered: true, installRequested: true, discoveredProfiles: 0 }
        : snapshot,
    );
    const { setup } = mount(nativeBridge(post, snapshot));
    expect(buttons(setup).map((button) => button.textContent?.trim())).toEqual([labels.install]);
    click(setup, labels.install);
    await expectText(setup, "Connection has not been verified on this device.");
    expect(post).toHaveBeenCalledWith({ type: "install-chrome-extension" });
    expect(post).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "chrome-extension-setup" }),
    );
    expect(setup.textContent).not.toContain("Extension connected on this device.");
  });
  it("discards a pending reply after detach/remount and preserves newer intent", async () => {
    const old = createDeferred<unknown>();
    const post = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(result(connected));
    const first = mount(bridge(post));
    click(first.setup, "Refresh setup status");
    first.unmount();
    const { setup } = mount(first.capability);
    click(setup, "Verify connection");
    await expectText(setup, "Extension connected on this device.");
    old.resolve(result());
    await old.promise;
    flush();
    expect(setup.textContent).toContain("Extension connected on this device.");
    expect(setup.textContent).not.toContain("Setup required");
  });
  it.each(["replaced handler", "mismatched action", "malformed phase"])(
    "rejects a setup reply with %s",
    async (reason) => {
      const pending = createDeferred<unknown>();
      const { setup } = mount(bridge(() => pending.promise));
      click(setup, "Refresh setup status");
      const replacement = vi.fn();
      if (reason === "replaced handler") {
        bridge(replacement);
      }
      pending.resolve({
        ...result(),
        ...(reason === "mismatched action" ? { action: "verify" } : {}),
        ...(reason === "malformed phase" ? { phase: "unknown" } : {}),
      });
      await expectText(setup, "Setup could not finish");
      expect(setup.textContent).not.toContain("Host:");
      expect(setup.textContent).not.toContain("Example Mac");
      if (reason === "replaced handler") {
        click(setup, "Set up Chrome on this device");
        await idle(setup);
        expect(replacement).not.toHaveBeenCalled();
      }
    },
  );
});
