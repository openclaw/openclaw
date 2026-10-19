import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext } from "../../app/context.ts";
import { createNativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import { i18n } from "../../i18n/index.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { createChromeExtensionSetupResult } from "../../test-helpers/chrome-extension-setup.ts";
/* @vitest-environment jsdom */
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createNativeDeviceSettingsSnapshot } from "../../test-helpers/native-device-settings.ts";
import { Apps } from "./view.tsx";

type SetupElement = HTMLElement & { updateComplete: Promise<boolean> };
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
let defaultCapability: ApplicationContext["nativeDeviceSettings"] = null;
const capabilities = new Set<NonNullable<ApplicationContext["nativeDeviceSettings"]>>();
function nativeBridge(
  postMessage: (message: { type: string; action?: string }) => Promise<unknown>,
  snapshot = createNativeDeviceSettingsSnapshot(),
) {
  Object.assign(window, { __OPENCLAW_NATIVE_DEVICE_SETTINGS__: snapshot });
  Object.defineProperty(window, "webkit", {
    configurable: true,
    value: {
      messageHandlers: { openclawDeviceSettings: { postMessage } },
    },
  });
  defaultCapability = createNativeDeviceSettingsCapability()!;
  capabilities.add(defaultCapability);
}
function bridge(postMessage: (message: { action: string }) => Promise<unknown>) {
  const snapshot = createNativeDeviceSettingsSnapshot();
  nativeBridge(
    (message) =>
      message.type === "chrome-extension-setup" && message.action
        ? postMessage({ action: message.action })
        : Promise.resolve(snapshot),
    snapshot,
  );
}
async function mount() {
  const host = createApplicationContextProvider({
    nativeDeviceSettings: defaultCapability,
  } as ApplicationContext);
  mountSolid(() => <Apps onNavigate={vi.fn()} />, { container: host });
  document.body.append(host);
  const setup = host.querySelector<SetupElement>("openclaw-native-chrome-setup")!;
  await setup.updateComplete;
  return { host, setup, card: setup.closest(".apps-card")! };
}
function click(setup: HTMLElement, label: string) {
  const button = [...setup.querySelectorAll("button")].find(
    (el) => el.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  button!.click();
}
const expectText = (setup: HTMLElement, text: string) =>
  vi.waitFor(() => expect(setup.textContent).toContain(text));
async function idle(setup: SetupElement) {
  await setup.updateComplete;
  await vi.waitFor(() => expect(setup.querySelector("button")!.disabled).toBe(false));
}
beforeEach(() => i18n.setLocale("en"));
afterEach(() => {
  document.body.replaceChildren();
  for (const capability of capabilities) {
    capability.dispose();
  }
  capabilities.clear();
  defaultCapability = null;
  Reflect.deleteProperty(window, "webkit");
  Reflect.deleteProperty(window, "__OPENCLAW_NATIVE_DEVICE_SETTINGS__");
  vi.restoreAllMocks();
});

describe("Apps local Chrome setup", () => {
  it("uses explicit native actions through the device-settings context", async () => {
    const post = vi.fn(async ({ action }: { action: string }) =>
      result({
        action: action as "inspect" | "install" | "verify",
        target: {
          ...result().target,
          hostname: "Example desktop",
          profile: "work",
          relayPort: 19444,
        },
        ...(action === "verify" ? connected : {}),
      }),
    );
    bridge(post);
    const { setup, card } = await mount();
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
    expect(setup.textContent).toContain("Example desktop");
    expect(setup.textContent).toContain("work");
    expect(setup.textContent).toContain("19444");
    expect(setup.textContent).toContain("does not mean eligible tabs");
    expect(post.mock.calls).toEqual(["inspect", "install", "verify"].map((action) => [{ action }]));
  });
  it("keeps only Store and docs in an ordinary browser", async () => {
    const { card, setup } = await mount();
    expect(setup.querySelector("button")).toBeNull();
    expect([...card.querySelectorAll("a")].map((a) => a.href)).toEqual([
      "https://chromewebstore.google.com/detail/openclaw/kcdjddhmeafeomebliikmbpblkmkfoig",
      "https://docs.openclaw.ai/tools/chrome-extension",
    ]);
  });
  it.each([
    { label: "legacy", actions: undefined, buttons: [labels.install] },
    { label: "none", actions: [], buttons: [] },
    { label: "inspect only", actions: ["inspect"], buttons: [labels.inspect] },
  ] as const)(
    "offers only advertised Mac actions or the released legacy install: $label",
    async ({ actions, buttons }) => {
      const snapshot = createNativeDeviceSettingsSnapshot();
      if (actions === undefined) {
        delete snapshot.browser!.chromeSetupActions;
      } else {
        snapshot.browser!.chromeSetupActions = [...actions];
      }
      const post = vi.fn(async (message: { type: string; action?: string }) => {
        if (message.type === "install-chrome-extension") {
          return { nativeHostRegistered: true, installRequested: true, discoveredProfiles: 0 };
        }
        if (message.type === "chrome-extension-setup") {
          return result({ action: message.action as "install" | "inspect" | "verify" });
        }
        return snapshot;
      });
      nativeBridge(post, snapshot);
      const { setup } = await mount();
      expect(
        [...setup.querySelectorAll("button")].map((button) => button.textContent?.trim()),
      ).toEqual(buttons);
      if (actions === undefined) {
        click(setup, labels.install);
        await expectText(setup, "Connection has not been verified on this device.");
        expect(post).toHaveBeenCalledWith({ type: "install-chrome-extension" });
        expect(post.mock.calls.some(([message]) => message.type === "chrome-extension-setup")).toBe(
          false,
        );
        expect(setup.textContent).not.toContain("Extension connected on this device.");
      } else {
        for (const action of actions) {
          click(setup, labels[action]);
          await idle(setup);
          expect(post).toHaveBeenCalledWith({ type: "chrome-extension-setup", action });
        }
        expect(
          post.mock.calls.some(([message]) => message.type === "install-chrome-extension"),
        ).toBe(false);
      }
    },
  );
  it("discards a pending reply after detach/remount and preserves newer intent", async () => {
    const old = createDeferred<unknown>();
    const post = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(result(connected));
    bridge(post);
    const { setup } = await mount();
    const parent = setup.parentElement!;
    click(setup, "Refresh setup status");
    setup.remove();
    parent.append(setup);
    await setup.updateComplete;
    click(setup, "Verify connection");
    await expectText(setup, "Extension connected on this device.");
    old.resolve(result());
    await old.promise;
    await setup.updateComplete;
    expect(setup.textContent).toContain("Extension connected on this device.");
    expect(setup.textContent).not.toContain("Setup required");
  });
  it.each(["replaced handler", "mismatched action", "malformed phase"])(
    "rejects a setup reply with %s",
    async (reason) => {
      const pending = createDeferred<unknown>();
      bridge(() => pending.promise);
      const { setup } = await mount();
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
