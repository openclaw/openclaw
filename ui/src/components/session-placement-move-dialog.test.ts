/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import {
  showSessionPlacementTargetDialog,
  type SessionPlacementTargetOptions,
} from "./session-placement-move-dialog.tsx";

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
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  restoreDialogPolyfill = installDialogPolyfill();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  document.body.replaceChildren();
  restoreDialogPolyfill();
  vi.unstubAllGlobals();
});

async function openChoices(modal: HTMLElement, label: string) {
  const trigger = modal.querySelector<HTMLButtonElement>(
    `button[aria-haspopup="menu"][aria-label="${label}"]`,
  )!;
  trigger.click();
  await waitForSolid(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
  const menu = document.getElementById(trigger.getAttribute("aria-controls")!)!;
  await waitForSolid(() => expect(menu.matches(":popover-open")).toBe(true));
  return menu;
}

function choice(menu: HTMLElement, label: string) {
  return menu.querySelector<HTMLButtonElement>(`[role="menuitemradio"][aria-label="${label}"]`)!;
}

describe.each(["dispatch", "move", "restart"] as const)("%s machine selection", (mode) => {
  it.each(["smaller", "configured", "explicit"] as const)(
    "submits the displayed %s choice",
    async (selectionKind) => {
      const { result, modal, submit, click } = await openDialog({
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
                default: selectionKind === "configured",
              },
              { id: "small", label: "Small", cpu: 8, memoryGb: 16 },
            ],
          },
        ],
      });
      click("cloud:cloud");
      const menu = await openChoices(modal, "Machine");
      if (selectionKind === "explicit") {
        menu
          .querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-label="Large"]')!
          .click();
        flush();
      }
      const machineClass = selectionKind === "smaller" ? "small" : "large";
      expect(
        menu.querySelector(`[data-value="${machineClass}"]`)?.getAttribute("aria-checked"),
      ).toBe("true");
      if (selectionKind !== "explicit") {
        menu.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
        flush();
      }
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

it.each(["Device ID", ""])(
  "preserves Cancel focus through catalog failure and retry with source label %j",
  async (sourceLabel) => {
    const catalog = createDeferred<Awaited<ReturnType<DialogOptions["loadCatalog"]>>>();
    const retryCatalog = createDeferred<Awaited<ReturnType<DialogOptions["loadCatalog"]>>>();
    const loadCatalog = vi
      .fn<DialogOptions["loadCatalog"]>()
      .mockReturnValueOnce(catalog.promise)
      .mockReturnValueOnce(retryCatalog.promise);
    const { result, modal, submit, click } = await openDialog({
      source: { label: sourceLabel, target: { kind: "device", deviceId: "device-a" } },
      loadCatalog,
    });
    const form = modal.querySelector("form");
    const cancel = modal.querySelector<HTMLButtonElement>(
      '.session-move__actions button[type="button"]',
    )!;
    cancel.focus();
    expect(modal.textContent).toContain("Loading");
    expect(submit.disabled).toBe(true);
    expect(modal.querySelector(".session-move__origin")?.textContent ?? "").toBe(sourceLabel);

    catalog.reject(new Error("Catalog unavailable"));
    await waitForSolid(() =>
      expect(modal.querySelector('[role="alert"]')?.textContent).toContain("Catalog unavailable"),
    );
    expect(document.activeElement).toBe(cancel);
    expect(modal.querySelector("form")).toBe(form);
    expect(modal.querySelector('button[type="submit"]')).toBe(submit);
    expect(submit.disabled).toBe(true);
    expect(modal.querySelector(".session-move__origin")?.textContent ?? "").toBe(sourceLabel);

    modal.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
    await waitForSolid(() => expect(loadCatalog).toHaveBeenCalledTimes(2));
    expect(document.activeElement).toBe(cancel);
    expect(submit.disabled).toBe(true);
    retryCatalog.resolve({
      profiles: [],
      devices: [{ deviceId: "device-a", label: "Desktop", facts: [], selectable: true }],
    });
    await waitForSolid(() =>
      expect(modal.querySelector(".session-move__origin")?.textContent).toBe("Desktop"),
    );
    expect(modal.querySelector(".session-move__origin span")?.getAttribute("title")).toBe(
      "Desktop",
    );
    expect(document.activeElement).toBe(cancel);
    expect(modal.querySelector("form")).toBe(form);
    expect(modal.querySelector('.session-move__actions button[type="button"]')).toBe(cancel);
    expect(modal.querySelector('button[type="submit"]')).toBe(submit);
    expect(submit.disabled).toBe(true);
    click("gateway");
    expect(submit.disabled).toBe(false);
    cancel.click();
    await expect(result).resolves.toBeNull();
  },
);

it("orders available Move profiles by label before blocked profiles", async () => {
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
  ).toEqual(["cloud:AWS", "cloud:Azure", "cloud:custom", "cloud:local", "cloud:production"]);
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
  expect(button("cloud:aws").textContent).toContain("aws");
  expect(button("cloud:aws").textContent).toContain("Azure");
  click("cloud:aws");
  let machines = await openChoices(modal, "Machine");
  expect(choice(machines, "Linux tiny").getAttribute("aria-checked")).toBe("true");
  expect(machines.textContent).not.toContain("Windows tiny");
  choice(machines, "Linux fast").click();
  flush();
  const operatingSystems = await openChoices(modal, "Operating system");
  expect(choice(operatingSystems, "Linux").getAttribute("aria-checked")).toBe("true");
  choice(operatingSystems, "Windows (WSL2)").click();
  flush();
  expect(choice(operatingSystems, "Windows (WSL2)").getAttribute("aria-checked")).toBe("true");
  machines = await openChoices(modal, "Machine");
  expect(machines.textContent).not.toContain("Linux fast");
  expect(choice(machines, "Windows tiny").getAttribute("aria-checked")).toBe("true");
  expect(choice(machines, "Portable").disabled).toBe(false);
  expect(machines.textContent).not.toContain("Linux tiny");
  choice(machines, "Portable").click();
  flush();
  submit.click();

  await expect(result).resolves.toEqual({
    kind: "profile",
    profileId: "aws",
    os: "windows/wsl2",
    machineClass: "portable",
  });
});

it.each([undefined, "Gateway unavailable"])(
  "requires explicit selection and respects Gateway blocker %s",
  async (gatewayDisabledReason) => {
    const result = showSessionPlacementTargetDialog({
      mode: "move",
      sessionLabel: "Example session",
      activeRun: false,
      gatewayDisabledReason,
      loadCatalog: async () => ({ profiles: [], devices: [] }),
    });
    flush();
    const { modal } = await getRenderedModalDialog(document.body);
    try {
      expect(modal.querySelector<HTMLButtonElement>('[data-value="gateway"]')!.disabled).toBe(
        Boolean(gatewayDisabledReason),
      );
      expect(modal.querySelector('[data-value="gateway"]')?.getAttribute("aria-pressed")).toBe(
        "false",
      );
      expect(modal.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
      modal.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
      flush();
      expect(modal.isConnected).toBe(true);
    } finally {
      modal.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));
      await expect(result).resolves.toBeNull();
    }
  },
);

it.each([
  { name: "removed OS", os: "windows", machineClass: "small", disabledOs: false, unchanged: false },
  {
    name: "removed machine",
    os: "linux",
    machineClass: "retired",
    disabledOs: false,
    unchanged: false,
  },
  { name: "disabled OS", os: "windows", machineClass: "small", disabledOs: true, unchanged: false },
  {
    name: "supported nondefault machine",
    os: "linux",
    machineClass: "large",
    disabledOs: false,
    unchanged: true,
  },
])(
  "reconciles $name against the current catalog before moving",
  async ({ os, machineClass, disabledOs, unchanged }) => {
    const catalog =
      createDeferred<Awaited<ReturnType<SessionPlacementTargetOptions["loadCatalog"]>>>();
    const result = showSessionPlacementTargetDialog({
      mode: "move",
      sessionLabel: "Example session",
      activeRun: false,
      gatewayDisabledReason: "Gateway unavailable",
      source: { label: "cloud", target: { kind: "profile", profileId: "cloud", os, machineClass } },
      loadCatalog: () => catalog.promise,
    });
    const { modal } = await getRenderedModalDialog(document.body);
    try {
      catalog.resolve({
        devices: [],
        profiles: [
          {
            id: "cloud",
            providerId: "worker",
            operatingSystems: [
              { id: "linux", label: "Linux", default: !disabledOs },
              ...(disabledOs
                ? [
                    {
                      id: "windows",
                      label: "Windows",
                      default: true,
                      disabledReason: "Unavailable",
                    },
                  ]
                : []),
            ],
            machines: [
              { id: "small", label: "Small", os: "linux", default: true },
              ...(unchanged ? [{ id: "large", label: "Large", os: "linux" }] : []),
            ],
          },
        ],
      });
      await waitForSolid(() =>
        expect(modal.querySelector('[data-value="cloud:cloud"]')).not.toBeNull(),
      );
      const submit = modal.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      expect(submit.disabled).toBe(true);
      modal.querySelector<HTMLButtonElement>('[data-value="cloud:cloud"]')!.click();
      flush();
      if (unchanged) {
        // A supported source remains selected in configuration, but is not a move.
        const machines = await openChoices(modal, "Machine");
        expect(choice(machines, "Large").getAttribute("aria-checked")).toBe("true");
        expect(submit.disabled).toBe(true);
        choice(machines, "Small").click();
        flush();
      } else {
        // The only replacement class is static; it must still be submittable.
        expect(
          modal.querySelector('button[aria-haspopup="menu"][aria-label="Machine"]'),
        ).toBeNull();
        expect(modal.querySelector(".session-move__fixed-value")?.textContent).toContain("Small");
      }
      expect(submit.disabled).toBe(false);
      submit.click();
      await expect(result).resolves.toEqual({
        kind: "profile",
        profileId: "cloud",
        os: "linux",
        machineClass: "small",
      });
    } finally {
      modal.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));
      await result;
    }
  },
);
