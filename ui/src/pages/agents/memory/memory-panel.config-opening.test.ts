/* @vitest-environment jsdom */

import { afterAll, afterEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../../test/helpers/promise.js";
import { cleanupSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createPage } from "./memory-panel.test-support.ts";
import { installDreamingViewTestTranslations } from "./view.test-helpers.ts";
import "../../../lib/toast-host.tsx";

const restoreTranslations = installDreamingViewTestTranslations();
afterAll(() => restoreTranslations());
afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function openConfigButton(container: Element) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    ["Open config", "Loading…"].includes(button.textContent?.trim() ?? ""),
  )!;
}

it("shows config opening until the owner completes", async () => {
  const page = await createPage();
  const pending = deferred();
  vi.mocked(page.context.runtimeConfig.openFile).mockReturnValueOnce(pending.promise);
  const button = openConfigButton(page.container);
  const originalLabel = button.textContent;
  button.click();
  await waitForSolid(() => {
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.textContent).toBe("Loading…");
  });
  expect(page.context.runtimeConfig.openFile).toHaveBeenCalledOnce();
  pending.resolve();
  await waitForSolid(() => {
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute("aria-busy")).toBe(false);
    expect(button.textContent).toBe(originalLabel);
  });
});

it("retires config opening on agent changes and shows a current failure before retry", async () => {
  const page = await createPage();
  const host = document.createElement("openclaw-toast-host");
  document.body.append(host);
  await host.updateComplete;
  const pending = deferred();
  const openFile = vi.mocked(page.context.runtimeConfig.openFile);
  openFile.mockReturnValueOnce(pending.promise);
  const button = openConfigButton(page.container);
  button.click();
  await waitForSolid(() => expect(button.disabled).toBe(true));
  page.setAgentId("other");
  await waitForSolid(() => expect(button.disabled).toBe(false));
  pending.reject(new Error("Retired config opening"));
  await Promise.allSettled([pending.promise]);
  await waitForSolid(() => expect(host.textContent).not.toContain("Retired config opening"));

  const currentButton = openConfigButton(page.container);
  openFile.mockRejectedValueOnce(new Error("Cannot open configuration"));
  currentButton.click();
  await waitForSolid(() => {
    expect(openFile).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("Cannot open configuration");
    expect(currentButton.disabled).toBe(false);
  });
  currentButton.click();
  await waitForSolid(() => expect(openFile).toHaveBeenCalledTimes(3));
  await waitForSolid(() => expect(currentButton.disabled).toBe(false));
});
