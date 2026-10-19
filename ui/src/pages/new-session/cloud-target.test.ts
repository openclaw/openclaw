/* @vitest-environment jsdom */

import { createComponent, createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { CloudProfileMenuItems, SessionMenuItem } from "./cloud-target-view.tsx";
import { requestPlaceCatalog, type CloudProfileMenuItemsOptions } from "./cloud-target.ts";
import {
  projectDevicePlacements,
  resolveAutomaticDevicePlacementDisabledReason,
} from "./device-placement.ts";

function mountCloudProfiles(options: Partial<CloudProfileMenuItemsOptions>) {
  const initial: CloudProfileMenuItemsOptions = {
    profiles: [],
    selectedId: "aws",
    compact: true,
    submitting: false,
    onSelect: vi.fn(),
    ...options,
  };
  const [params, setParams] = createSignal(initial);
  const mounted = mountSolid(() =>
    createComponent(CloudProfileMenuItems, {
      get params() {
        return params();
      },
    }),
  );
  return {
    ...mounted,
    update: (next: Partial<CloudProfileMenuItemsOptions>) => {
      setParams({ ...initial, ...next });
      flush();
    },
  };
}

describe("cloud target menu", () => {
  it("orders Gateway catalogs while retaining placement facts and omitting unsupported kinds", async () => {
    const machine = { id: "small", label: "Small", cpu: 2, memoryGb: 4 };
    const profile = { id: "zeta", providerId: "crabbox", machines: [machine] };
    const environment = { id: "node:zeta", type: "node", status: "available" };
    const request = vi.fn().mockResolvedValue({
      profiles: [profile, { id: "alpha", providerId: "crabbox" }],
      environments: [
        environment,
        { id: "node:alpha", type: "node", status: "available" },
        { id: "future", type: "future", status: "available" },
      ],
    });
    const catalog = await requestPlaceCatalog({ request }, "openclaw");
    expect(request).toHaveBeenCalledExactlyOnceWith("environments.list", { runtimeId: "openclaw" });
    expect(catalog.profiles.map((entry) => entry.id)).toEqual(["alpha", "zeta"]);
    expect(catalog.environments.map((entry) => entry.id)).toEqual(["node:alpha", "node:zeta"]);
    expect(catalog.profiles[1]).toEqual(profile);
  });

  it("renders saved-pairing remediation commands without redeeming a new join URL", () => {
    const { container } = mountSolid(() =>
      createComponent(SessionMenuItem, {
        item: {
          compact: true,
          onSelect: vi.fn(),
          value: "device:disabled",
          label: "Device",
          disabled: true,
          checked: false,
          title: "Hosting disabled",
          remediation: "enable-session-hosting",
        },
        submitting: false,
      }),
    );
    const card = container.querySelector('[slot="content"]');
    expect(card?.textContent).toContain(
      "Session hosting is disabled. Run these commands on the paired device:",
    );
    expect(Array.from(card!.querySelectorAll("code"), (command) => command.textContent)).toEqual([
      "openclaw config set nodeHost.workerRuns.enabled true",
      "openclaw node install --force",
    ]);
  });

  it("explains missing hosting without claiming a connected device is unpaired", () => {
    const environments = [
      {
        id: "node:paired",
        type: "node" as const,
        status: "available" as const,
        sessionHost: false,
      },
    ];
    const devices = projectDevicePlacements(environments);
    const { container } = mountSolid(() =>
      createComponent(SessionMenuItem, {
        item: {
          compact: true,
          onSelect: vi.fn(),
          value: "auto",
          label: "Auto",
          disabled: true,
          checked: false,
          title: resolveAutomaticDevicePlacementDisabledReason(environments, devices),
        },
        submitting: false,
      }),
    );
    expect(container.querySelector('[slot="content"]')?.textContent?.trim()).toBe(
      "No devices have session hosting enabled. Connect a machine with session hosting enabled, or enable it on a paired device.",
    );
  });

  it("shows unselected provider defaults as suggestions and selects the provider before an explicit choice", () => {
    const onSelect = vi.fn();
    const onSelectOs = vi.fn();
    const params = {
      profiles: [
        {
          id: "aws",
          providerId: "aws",
          operatingSystems: [
            { id: "linux", label: "Linux", default: true },
            { id: "windows", label: "Windows" },
          ],
          machines: [
            { id: "small", label: "Small", default: true },
            { id: "standard", label: "Standard" },
          ],
        },
      ],
      selectedId: "",
      onSelect,
      onSelectOs,
    };
    const { container, update } = mountCloudProfiles(params);
    const suggested = container.querySelector<HTMLButtonElement>('[data-value="os:linux"]')!;
    expect(suggested.dataset.suggested).toBe("true");
    expect(suggested.getAttribute("aria-pressed")).toBe("true");
    expect(
      container.querySelector('[data-value="machine:small"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
    suggested.click();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("aws", true);
    expect(onSelectOs).toHaveBeenCalledExactlyOnceWith("linux");
    update({ ...params, selectedId: "aws" });
    expect(
      container.querySelector('[data-value="os:linux"]')?.getAttribute("data-suggested"),
    ).toBeNull();
    expect(container.querySelector('[data-value="os:linux"]')?.getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it.each([
    {
      machine: { id: "standard", label: "Standard", cpu: 32, memoryGb: 64 },
      expected: "32 vCPU · 64 GB",
    },
    { machine: { id: "compute", label: "Compute", cpu: 48 }, expected: "48 vCPU" },
    { machine: { id: "memory", label: "Memory", memoryGb: 256 }, expected: "256 GB" },
    { machine: { id: "custom", label: "Custom" }, expected: "Custom" },
  ])("renders a single machine as fixed provider configuration", ({ machine, expected }) => {
    const { container } = mountCloudProfiles({
      profiles: [{ id: "aws", providerId: "aws", machines: [machine] }],
      selectedMachine: machine.id,
    });
    const machineLabel = container.querySelector(`[data-value="machine:${machine.id}"]`);
    expect(machineLabel?.classList.contains("new-session-page__fixed-machine")).toBe(true);
    expect(machineLabel?.textContent).toContain(expected);
    expect(machineLabel?.tagName).toBe("SPAN");
  });

  it("forwards configuration choices and disables them while submitting", () => {
    const onSelectMachine = vi.fn();
    const onSelectOs = vi.fn();
    const params = {
      profiles: [
        {
          id: "aws",
          providerId: "aws",
          operatingSystems: [
            { id: "linux", label: "Linux" },
            { id: "macos", label: "macOS" },
          ],
          machines: [
            { id: "small", label: "Small" },
            { id: "large", label: "Large" },
          ],
        },
      ],
      selectedOs: "linux",
      selectedMachine: "small",
      onSelectMachine,
      onSelectOs,
    };
    const { container, update } = mountCloudProfiles(params);
    container.querySelector<HTMLButtonElement>('[data-value="machine:large"]')!.click();
    container.querySelector<HTMLButtonElement>('[data-value="os:macos"]')!.click();
    expect(onSelectMachine).toHaveBeenCalledExactlyOnceWith("large");
    expect(onSelectOs).toHaveBeenCalledExactlyOnceWith("macos");
    update({ ...params, submitting: true });
    expect([...container.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
  });

  it("omits unavailable OS choices even when they are the current selection", () => {
    const { container } = mountCloudProfiles({
      profiles: [
        {
          id: "aws",
          providerId: "aws",
          operatingSystems: [
            { id: "linux", label: "Linux" },
            { id: "windows", label: "Windows", disabledReason: "Install WSL2" },
          ],
        },
      ],
      selectedOs: "windows",
    });
    const fixedOs = container.querySelector('[data-value="os:linux"]');
    expect(fixedOs?.textContent).toBe("Linux");
    expect(fixedOs?.tagName).toBe("SPAN");
    expect(fixedOs?.hasAttribute("aria-pressed")).toBe(false);
    expect(container.querySelector('[data-value="os:windows"]')).toBeNull();
    expect(
      container.querySelector('.new-session-page__cloud-configuration [aria-pressed="true"]'),
    ).toBeNull();
  });

  it("disables cloud profiles with the runtime preflight reason", () => {
    const { container } = mountCloudProfiles({
      profiles: [{ id: "aws", providerId: "crabbox" }],
      selectedId: "",
      disabled: true,
      disabledReason: "The acpx runtime does not support cloud workers.",
    });

    const button = container.querySelector<HTMLButtonElement>('[data-value="cloud:aws"]');
    expect(button?.disabled).toBe(true);
    expect(button?.title).toBe("The acpx runtime does not support cloud workers.");
  });

  it("disables only the cloud profile with a profile-specific reason", () => {
    const reason =
      "The codex runtime cannot use this cloud worker. Choose a compatible cloud worker or run locally.";
    const { container } = mountCloudProfiles({
      profiles: [
        { id: "aws", providerId: "crabbox" },
        { id: "ssh", providerId: "static-ssh" },
      ],
      selectedId: "",
      profileDisabledReason: (profile) => (profile.id === "aws" ? reason : undefined),
    });

    const disabled = container.querySelector<HTMLButtonElement>('[data-value="cloud:aws"]');
    const enabled = container.querySelector<HTMLButtonElement>('[data-value="cloud:ssh"]');
    expect(disabled?.disabled).toBe(true);
    expect(disabled?.title).toBe(reason);
    expect(enabled?.disabled).toBe(false);
    expect(enabled?.title).toBe("Cloud worker provider: static-ssh");
  });
});
