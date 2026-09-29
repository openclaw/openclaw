/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { showSessionPlacementTargetDialog } from "./session-placement-move-dialog.ts";

let restoreDialogPolyfill: () => void;

beforeEach(() => {
  restoreDialogPolyfill = installDialogPolyfill();
});

afterEach(() => {
  document.body.replaceChildren();
  restoreDialogPolyfill();
});

it("does not repaint a cancelled placement dialog when its catalog finishes loading", async () => {
  const catalog = createDeferred<{ profiles: []; devices: [] }>();
  const result = showSessionPlacementTargetDialog({
    mode: "move",
    sessionLabel: "Example session",
    activeRun: false,
    loadCatalog: () => catalog.promise,
  });
  const { modal } = await getRenderedModalDialog(document.body);
  const host = modal.parentElement;
  if (!host) {
    throw new Error("Expected the placement dialog's host");
  }

  modal.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));
  await expect(result).resolves.toBeNull();
  expect(host.isConnected).toBe(false);

  catalog.resolve({ profiles: [], devices: [] });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

  expect(host.childElementCount).toBe(0);
});

it("orders Move profiles by backend while keeping local selection and blockers", async () => {
  const result = showSessionPlacementTargetDialog({
    mode: "move",
    sessionLabel: "Example session",
    activeRun: false,
    profileDisabledReason: (profile) => (profile.id === "production" ? "Unavailable" : undefined),
    loadCatalog: async () => ({
      devices: [],
      profiles: [
        { id: "AWS", providerId: "crabbox", providerDisplayId: "local-container" },
        { id: "Azure", providerId: "crabbox", providerDisplayId: "incus" },
        { id: "custom", providerId: "custom-worker" },
        { id: "production", providerId: "crabbox", providerDisplayId: "aws" },
        { id: "local", providerId: "crabbox", providerDisplayId: "machine0" },
      ],
    }),
  });
  const { modal } = await getRenderedModalDialog(document.body);
  try {
    expect(
      [...modal.querySelectorAll('[data-value^="cloud:"]')].map((row) =>
        row.getAttribute("data-value"),
      ),
    ).toEqual(["cloud:local", "cloud:production", "cloud:AWS", "cloud:Azure", "cloud:custom"]);
    expect(
      modal.querySelector<HTMLButtonElement>('[data-value="cloud:production"]')!.disabled,
    ).toBe(true);
    modal.querySelector<HTMLButtonElement>('[data-value="cloud:AWS"]')!.click();
    expect(modal.querySelector('[data-value="cloud:AWS"]')?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    modal.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await expect(result).resolves.toEqual({ kind: "profile", profileId: "AWS" });
  } finally {
    modal.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));
    await result;
  }
});

it("moves with the selected OS and limits machine choices to that OS", async () => {
  const result = showSessionPlacementTargetDialog({
    mode: "move",
    sessionLabel: "Example session",
    activeRun: false,
    loadCatalog: async () => ({
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
      devices: [],
    }),
  });
  const { modal } = await getRenderedModalDialog(document.body);
  const button = (value: string) => {
    const element = modal.querySelector<HTMLButtonElement>(`[data-value="${value}"]`);
    if (!element) {
      throw new Error(`Expected placement choice ${value}`);
    }
    return element;
  };

  try {
    expect(button("cloud:aws").querySelector('[data-provider-icon="azure"]')).not.toBeNull();
    expect(button("cloud:aws").hasAttribute("aria-label")).toBe(false);
    expect(button("cloud:aws").querySelector(".session-menu__text")?.textContent?.trim()).toBe(
      "Cloud · aws",
    );
    expect(button("cloud:aws").getAttribute("aria-description")).toBe(
      "Cloud worker provider: Azure",
    );
    button("cloud:aws").click();
    expect(button("os:linux").getAttribute("aria-pressed")).toBe("true");
    expect(button("machine:tiny").textContent).toContain("Linux tiny");
    expect(modal.textContent).not.toContain("Windows tiny");
    button("machine:fast").click();

    button("os:windows/wsl2").click();
    expect(button("os:windows/wsl2").getAttribute("aria-pressed")).toBe("true");
    expect(modal.querySelector('[data-value="machine:fast"]')).toBeNull();
    expect(button("machine:tiny").textContent).toContain("Windows tiny");
    expect(button("machine:tiny").getAttribute("aria-pressed")).toBe("true");
    expect(button("machine:portable").disabled).toBe(false);
    expect(modal.textContent).not.toContain("Linux tiny");
    button("machine:portable").click();
    const submit = modal.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (!submit) {
      throw new Error("Expected the move action");
    }
    submit.click();

    await expect(result).resolves.toEqual({
      kind: "profile",
      profileId: "aws",
      os: "windows/wsl2",
      machineClass: "portable",
    });
  } finally {
    modal.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));
    await result;
  }
});

it.each(["dispatch", "move", "restart"] as const)(
  "%s submits the preselected Small class without requiring a machine click",
  async (mode) => {
    const result = showSessionPlacementTargetDialog({
      mode,
      sessionLabel: "Example session",
      activeRun: false,
      loadCatalog: async () => ({
        devices: [],
        profiles: [
          {
            id: "aws",
            providerId: "crabbox",
            operatingSystems: [{ id: "linux", label: "Linux", default: true }],
            machines: [
              { id: "standard", label: "Standard", cpu: 32, default: true },
              { id: "small", label: "Small", cpu: 8 },
            ],
          },
        ],
      }),
    });
    const { modal } = await getRenderedModalDialog(document.body);
    try {
      modal.querySelector<HTMLButtonElement>('[data-value="cloud:aws"]')!.click();
      expect(
        modal.querySelector('[data-value="machine:small"]')?.getAttribute("aria-pressed"),
      ).toBe("true");
      modal.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
      await expect(result).resolves.toEqual({
        kind: "profile",
        profileId: "aws",
        os: "linux",
        machineClass: "small",
      });
    } finally {
      modal.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));
      await result;
    }
  },
);
