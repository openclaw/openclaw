/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { showSessionPlacementTargetDialog } from "./session-placement-move-dialog.tsx";

let restoreDialogPolyfill: () => void;
const cleanups: (() => Promise<unknown>)[] = [];

type DialogOptions = Parameters<typeof showSessionPlacementTargetDialog>[0];
type Profiles = Awaited<ReturnType<DialogOptions["loadCatalog"]>>["profiles"];
async function openDialog({
  profiles = [],
  ...options
}: Partial<DialogOptions> & { profiles?: Profiles } = {}) {
  const result = showSessionPlacementTargetDialog({
    mode: "move",
    sessionLabel: "Example session",
    activeRun: false,
    loadCatalog: async () => ({ profiles, devices: [] }),
    ...options,
  });
  flush();
  const { modal } = await getRenderedModalDialog(document.body);
  cleanups.push(async () => {
    modal.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));
    await result;
  });
  const button = (value: string) =>
    modal.querySelector<HTMLButtonElement>(`[data-value="${value}"]`)!;
  const submit = modal.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const click = (value: string) => {
    button(value).click();
    flush();
  };
  return { result, modal, button, submit, click };
}

beforeEach(() => {
  restoreDialogPolyfill = installDialogPolyfill();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  document.body.replaceChildren();
  restoreDialogPolyfill();
});

describe.each(["dispatch", "move", "restart"] as const)("%s machine selection", (mode) => {
  it.each(["smaller", "configured", "explicit"] as const)(
    "submits the displayed %s choice",
    async (choice) => {
      const { result, button, submit, click } = await openDialog({
        mode,
        profiles: [
          {
            id: "cloud",
            providerId: "worker",
            operatingSystems: [{ id: "linux", label: "Linux", default: true }],
            machines: [
              {
                id: "large",
                label: "Large",
                cpu: 32,
                memoryGb: 64,
                default: choice === "configured",
              },
              { id: "small", label: "Small", cpu: 8, memoryGb: 16 },
            ],
          },
        ],
      });
      click("cloud:cloud");
      if (choice === "explicit") {
        click("machine:large");
      }
      const machineClass = choice === "smaller" ? "small" : "large";
      expect(button(`machine:${machineClass}`).getAttribute("aria-pressed")).toBe("true");
      submit.click();
      await expect(result).resolves.toEqual({
        kind: "profile",
        profileId: "cloud",
        os: "linux",
        machineClass,
      });
    },
  );
});

it("ignores catalog completion after cancellation", async () => {
  const catalog = createDeferred<{ profiles: []; devices: [] }>();
  const { result, modal } = await openDialog({ loadCatalog: () => catalog.promise });
  const host = modal.parentElement!;

  modal.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));
  await expect(result).resolves.toBeNull();
  expect(host.isConnected).toBe(false);

  catalog.resolve({ profiles: [], devices: [] });
  await catalog.promise;
  await waitForSolid(() => expect(host.childElementCount).toBe(0));
});

it("preserves Cancel focus and disabled submission on load failure", async () => {
  const catalog = createDeferred<{ profiles: []; devices: [] }>();
  const { result, modal, submit } = await openDialog({ loadCatalog: () => catalog.promise });
  const cancel = modal.querySelector<HTMLButtonElement>(
    '.exec-approval-actions button[type="button"]',
  )!;
  cancel.focus();
  expect(modal.textContent).toContain("Loading");
  expect(submit.disabled).toBe(true);

  catalog.reject(new Error("Catalog unavailable"));
  await waitForSolid(() =>
    expect(modal.querySelector('[role="alert"]')?.textContent).toBe("Catalog unavailable"),
  );
  expect(document.activeElement).toBe(cancel);
  expect(modal.querySelector('button[type="submit"]')).toBe(submit);
  expect(submit.disabled).toBe(true);
  cancel.click();
  await expect(result).resolves.toBeNull();
});

it("orders profiles by backend and retains selection blockers", async () => {
  const { result, modal, button, submit, click } = await openDialog({
    profileDisabledReason: (profile) => (profile.id === "production" ? "Unavailable" : undefined),
    profiles: [
      { id: "AWS", providerId: "crabbox", providerDisplayId: "local-container" },
      { id: "Azure", providerId: "crabbox", providerDisplayId: "incus" },
      { id: "custom", providerId: "custom-worker" },
      { id: "production", providerId: "crabbox", providerDisplayId: "aws" },
      { id: "local", providerId: "crabbox", providerDisplayId: "machine0" },
    ],
  });
  expect(
    [...modal.querySelectorAll('[data-value^="cloud:"]')].map((row) =>
      row.getAttribute("data-value"),
    ),
  ).toEqual(["cloud:local", "cloud:production", "cloud:AWS", "cloud:Azure", "cloud:custom"]);
  expect(button("cloud:production").disabled).toBe(true);
  click("cloud:AWS");
  expect(button("cloud:AWS").getAttribute("aria-pressed")).toBe("true");
  submit.click();
  await expect(result).resolves.toEqual({ kind: "profile", profileId: "AWS" });
});

it("moves with the selected OS and limits machine choices to that OS", async () => {
  const { result, modal, button, submit, click } = await openDialog({
    profiles: [
      {
        id: "aws",
        providerId: "crabbox",
        providerDisplayId: "azure",
        operatingSystems: [
          { id: "linux", label: "Linux", default: true },
          { id: "windows/wsl2", label: "Windows (WSL2)" },
        ],
        machines: [
          { id: "tiny", label: "Linux tiny", os: "linux", default: true },
          { id: "fast", label: "Linux fast", os: "linux" },
          { id: "tiny", label: "Windows tiny", os: "windows/wsl2", default: true },
          { id: "portable", label: "Portable" },
        ],
      },
    ],
  });
  expect(button("cloud:aws").querySelector('[data-provider-icon="azure"]')).not.toBeNull();
  expect(button("cloud:aws").hasAttribute("aria-label")).toBe(false);
  expect(button("cloud:aws").querySelector(".session-menu__text")?.textContent?.trim()).toBe(
    "Cloud · aws",
  );
  expect(button("cloud:aws").getAttribute("aria-description")).toBe("Cloud worker provider: Azure");
  click("cloud:aws");
  expect(button("os:linux").getAttribute("aria-pressed")).toBe("true");
  expect(button("machine:tiny").textContent).toContain("Linux tiny");
  expect(modal.textContent).not.toContain("Windows tiny");
  click("machine:fast");
  click("os:windows/wsl2");
  expect(button("os:windows/wsl2").getAttribute("aria-pressed")).toBe("true");
  expect(modal.querySelector('[data-value="machine:fast"]')).toBeNull();
  expect(button("machine:tiny").textContent).toContain("Windows tiny");
  expect(button("machine:tiny").getAttribute("aria-pressed")).toBe("true");
  expect(button("machine:portable").disabled).toBe(false);
  expect(modal.textContent).not.toContain("Linux tiny");
  click("machine:portable");
  submit.click();

  await expect(result).resolves.toEqual({
    kind: "profile",
    profileId: "aws",
    os: "windows/wsl2",
    machineClass: "portable",
  });
});

it("does not select or submit a disabled default Gateway target", async () => {
  const { result, modal, button, submit } = await openDialog({
    gatewayDisabledReason: "Gateway unavailable",
  });
  expect(button("gateway").disabled).toBe(true);
  expect(button("gateway").getAttribute("aria-pressed")).toBe("false");
  expect(submit.disabled).toBe(true);
  modal.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  flush();
  expect(modal.isConnected).toBe(true);
  modal.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));
  await expect(result).resolves.toBeNull();
});
