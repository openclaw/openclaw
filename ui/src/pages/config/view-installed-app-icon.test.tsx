import { createSignal } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
} from "../../app/gateway-store.test-support.ts";
import * as icons from "../../app/pwa-install-icon.ts";
import {
  bindInstallIconProfile,
  installIconSelection,
  selectPwaInstallIcon,
} from "../../app/pwa-install-selection.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import * as deviceIdentity from "../../lib/nodes/index.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { InstalledAppIcon } from "./view-installed-app-icon.tsx";

registerEnglishCatalog(registerSettingsEnglish);
afterEach(() => vi.restoreAllMocks());

function mockInstallDevice() {
  vi.spyOn(deviceIdentity, "loadOrCreateDeviceIdentity").mockResolvedValue({
    deviceId: "1".repeat(64),
    publicKey: "test-public",
    privateKey: "test-private",
  });
}

function setup() {
  const privateIcon = "/base/pwa-icon/" + "a".repeat(64) + "/icon.png";
  const { gateway, current } = createGatewayStoreTestStore();
  const stop = bindInstallIconProfile(gateway, "/base", () => true);
  const login = (id: string) => {
    gateway.connect();
    current().testOptions.onHello?.({
      ...GATEWAY_STORE_TEST_HELLO,
      snapshot: {
        presence: [
          {
            ts: 0,
            instanceId: current().instanceId,
            user: { id, identity: { type: "profile", id } },
          },
        ],
      },
    });
    flush();
  };
  login("installer");
  onTestFinished(() => {
    gateway.stop();
    stop();
    localStorage.clear();
  });
  const save = vi.spyOn(icons, "savePwaInstallIcon").mockImplementation(async () => {
    selectPwaInstallIcon(installIconSelection.owner!, privateIcon);
  });
  const reset = vi.spyOn(icons, "resetPwaInstallIcon").mockImplementation(async () => {
    selectPwaInstallIcon(installIconSelection.owner!, null);
  });
  const [picture, setPicture] = createSignal<string | null>(null);
  const view = mountSolid(() => <InstalledAppIcon agentPicture={picture()} />);
  flush();
  const button = (name: string) => view.getByRole<HTMLButtonElement>("button", { name });
  const preview = () => view.getByRole("img").getAttribute("src");
  const status = () => view.getByRole("status").textContent;
  return { login, gateway, view, privateIcon, save, reset, setPicture, button, preview, status };
}

it("snapshots the selected agent only after a click and restores the bundled icon on reset", async () => {
  const { view, privateIcon, save, reset, setPicture, button, preview, status } = setup();
  const installLink = () => view.queryByRole("link", { name: "Open install page" });
  expect(installLink()).toBeNull();
  const agent = button("Use current agent picture");
  const defaults = button("Use OpenClaw default");
  expect(agent.disabled).toBe(true);
  expect(defaults.disabled).toBe(false);
  const original = preview();
  expect(original).toContain("apple-touch-icon.png");
  expect(view.container.textContent).toContain("Anyone with that link");
  setPicture("/avatars/one");
  flush();
  setPicture("/avatars/two");
  flush();
  expect(save).not.toHaveBeenCalled();
  agent.click();
  await waitForSolid(() => expect(preview()).toBe(privateIcon));
  expect(save).toHaveBeenCalledExactlyOnceWith("/avatars/two");
  expect(installLink()?.getAttribute("href")).toBe(privateIcon.replace("icon.png", "install"));
  expect(installLink()?.getAttribute("rel")).toBe("noreferrer");
  expect(status()).toContain("saved");
  setPicture("/avatars/three");
  flush();
  expect(preview()).toBe(privateIcon);
  expect(save).toHaveBeenCalledOnce();
  defaults.click();
  await waitForSolid(() => expect(preview()).toBe(original));
  expect(reset).toHaveBeenCalledOnce();
  expect(installLink()).toBeNull();
});

it("opens the file chooser without uploading and preserves the icon if the chosen upload fails", async () => {
  const { view, save, privateIcon, button, preview } = setup();
  const original = preview();
  const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
  const choose = vi.spyOn(input, "click").mockImplementation(() => {});
  button("Upload custom picture…").click();
  expect(choose).toHaveBeenCalledOnce();
  input.dispatchEvent(new Event("change", { bubbles: true }));
  expect(save).not.toHaveBeenCalled();
  const file = new File(["synthetic"], "portrait.png", { type: "image/png" });
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  button("Upload custom picture…").click();
  save.mockRejectedValueOnce(new Error("Upload failed"));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await waitForSolid(() => expect(view.getByRole("alert").textContent).toContain("Upload failed"));
  expect(preview()).toBe(original);
  button("Upload custom picture…").click();
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await waitForSolid(() => expect(preview()).toBe(privateIcon));
  expect(save).toHaveBeenCalledTimes(2);
  expect(save).toHaveBeenLastCalledWith(file);
  expect(view.queryByRole("alert")).toBeNull();
});

it("restores each signed-in profile’s selection and clears the preview between admissions", async () => {
  const { gateway, login, privateIcon, setPicture, button, preview, status } = setup();
  const original = preview();
  setPicture("/avatars/one");
  flush();
  button("Use current agent picture").click();
  await waitForSolid(() => expect(preview()).toBe(privateIcon));
  gateway.stop();
  flush();
  expect(preview()).toBe(original);
  expect(button("Use OpenClaw default").disabled).toBe(true);
  login("second-installer");
  expect(preview()).toBe(original);
  expect(status()).not.toContain("saved");
  login("installer");
  expect(preview()).toBe(privateIcon);
  button("Use OpenClaw default").click();
  await waitForSolid(() => expect(preview()).toBe(original));
});

it.each([
  [403, { type: "forbidden", message: "missing scope: operator.write" }, "needs write access"],
  [429, "icon_store_busy", "Wait a moment"],
  [507, "icon_store_full", "Restore the default in another browser"],
] as const)(
  "offers a recovery action after HTTP %i and lets the owner retry",
  async (status, error, action) => {
    const { reset, view, button } = setup();
    reset.mockRestore();
    mockInstallDevice();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ error }, { status }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    button("Use OpenClaw default").click();
    await waitForSolid(() => expect(view.getByRole("alert").textContent).toContain(action));
    button("Use OpenClaw default").click();
    await waitForSolid(() => expect(view.getByRole("status").textContent).toContain("saved"));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.lastCall?.[1]).toMatchObject({
      method: "DELETE",
      headers: { "x-openclaw-install-profile": "installer" },
    });
  },
);

it("keeps a file choice bound to the admission that opened the picker", () => {
  const { login, view, save, button } = setup();
  const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
  vi.spyOn(input, "click").mockImplementation(() => {});
  button("Upload custom picture…").click();
  login("second-installer");
  Object.defineProperty(input, "files", {
    value: [new File(["synthetic"], "picture.png", { type: "image/png" })],
  });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  flush();
  expect(save).not.toHaveBeenCalled();
});

it("cancels the previous profile’s pending reset without acknowledging it in the next profile", async () => {
  const { login, reset, button, status } = setup();
  reset.mockRestore();
  mockInstallDevice();
  const pending = createDeferred<Response>();
  const fetch = vi.spyOn(globalThis, "fetch").mockReturnValueOnce(pending.promise);
  button("Use OpenClaw default").click();
  await waitForSolid(() => expect(fetch).toHaveBeenCalledOnce());
  login("second-installer");
  const request = fetch.mock.calls[0]![1];
  expect(request?.signal?.aborted).toBe(true);
  pending.resolve(new Response(null, { status: 204 }));
  await waitForSolid(() => expect(button("Use OpenClaw default").disabled).toBe(false));
  expect(status()).not.toContain("saved");
});
