import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import * as icons from "../../app/pwa-install-icon.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { InstalledAppIcon } from "./view-installed-app-icon.tsx";

registerEnglishCatalog(registerSettingsEnglish);
afterEach(() => vi.restoreAllMocks());

function setup() {
  const privateIcon = "/base/pwa-icon/test-only/icon.png";
  let selected: string | null = null;
  vi.spyOn(icons, "currentPwaInstallIcon").mockImplementation(() => selected);
  const save = vi.spyOn(icons, "savePwaInstallIcon").mockImplementation(async () => {
    selected = privateIcon;
  });
  const reset = vi.spyOn(icons, "resetPwaInstallIcon").mockImplementation(async () => {
    selected = null;
  });
  const [picture, setPicture] = createSignal<string | null>(null);
  const view = mountSolid(() => <InstalledAppIcon agentPicture={picture()} />);
  flush();
  const button = (name: string) => view.getByRole<HTMLButtonElement>("button", { name });
  const preview = () => view.getByRole("img").getAttribute("src");
  const status = () => view.getByRole("status").textContent;
  return { view, privateIcon, save, reset, setPicture, button, preview, status };
}

it("snapshots the selected agent only after a click and restores the bundled icon on reset", async () => {
  const { view, privateIcon, save, reset, setPicture, button, preview, status } = setup();
  const agent = button("Use current agent picture");
  const defaults = button("Use OpenClaw default");
  expect(agent.disabled).toBe(true);
  expect(defaults.disabled).toBe(true);
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
  expect(status()).toContain("saved");
  setPicture("/avatars/three");
  flush();
  expect(preview()).toBe(privateIcon);
  expect(save).toHaveBeenCalledOnce();
  defaults.click();
  await waitForSolid(() => expect(preview()).toBe(original));
  expect(reset).toHaveBeenCalledOnce();
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
  save.mockRejectedValueOnce(new Error("Upload failed"));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await waitForSolid(() => expect(view.getByRole("alert").textContent).toContain("Upload failed"));
  expect(preview()).toBe(original);
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await waitForSolid(() => expect(preview()).toBe(privateIcon));
  expect(save).toHaveBeenCalledTimes(2);
  expect(save).toHaveBeenLastCalledWith(file);
  expect(view.queryByRole("alert")).toBeNull();
});
