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

type Profile = CloudProfileMenuItemsOptions["profiles"][number];
function mountCloudProfiles({
  profile = {},
  ...options
}: Partial<CloudProfileMenuItemsOptions> & { profile?: Partial<Profile> }) {
  const initial: CloudProfileMenuItemsOptions = {
    profiles: [{ id: "aws", providerId: "aws", ...profile }],
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
    find: <T extends HTMLElement = HTMLElement>(value: string) =>
      mounted.container.querySelector<T>(`[data-value="${value}"]`),
    update: (next: Partial<CloudProfileMenuItemsOptions>) => {
      setParams({ ...initial, ...next });
      flush();
    },
  };
}

describe("cloud target menu", () => {
  const linux = { id: "linux", label: "Linux" };
  const small = { id: "small", label: "Small" };
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

  it.each(["disabled", "missing"] as const)("explains %s hosting without re-pairing", (mode) => {
    const environments = [
      {
        id: "node:paired",
        type: "node" as const,
        status: "available" as const,
        sessionHost: false,
      },
    ];
    const { container } = mountSolid(() =>
      createComponent(SessionMenuItem, {
        item: {
          value: mode === "disabled" ? "device:disabled" : "auto",
          label: mode === "disabled" ? "Device" : "Auto",
          compact: true,
          checked: false,
          disabled: true,
          onSelect: vi.fn(),
          title:
            mode === "disabled"
              ? "Hosting disabled"
              : resolveAutomaticDevicePlacementDisabledReason(
                  environments,
                  projectDevicePlacements(environments),
                ),
          remediation: mode === "disabled" ? "enable-session-hosting" : undefined,
        },
        submitting: false,
      }),
    );
    const card = container.querySelector('[slot="content"]');
    if (mode === "disabled") {
      expect(card?.textContent).toContain(
        "Session hosting is disabled. Run these commands on the paired device:",
      );
      expect(Array.from(card!.querySelectorAll("code"), (command) => command.textContent)).toEqual([
        "openclaw config set nodeHost.workerRuns.enabled true",
        "openclaw node install --force",
      ]);
    } else {
      expect(card?.textContent?.trim()).toBe(
        "No devices have session hosting enabled. Connect a machine with session hosting enabled, or enable it on a paired device.",
      );
    }
  });

  it("shows unselected provider defaults as suggestions and selects the provider before an explicit choice", () => {
    const onSelect = vi.fn();
    const onSelectOs = vi.fn();
    const params = {
      profile: {
        operatingSystems: [
          { ...linux, default: true },
          { id: "windows", label: "Windows" },
        ],
        machines: [
          { ...small, default: true },
          { id: "standard", label: "Standard" },
        ],
      },
      selectedId: "",
      onSelect,
      onSelectOs,
    };
    const { find, update } = mountCloudProfiles(params);
    const suggested = find("os:linux")!;
    expect(suggested.dataset.suggested).toBe("true");
    expect(suggested.getAttribute("aria-pressed")).toBe("true");
    expect(find("machine:small")?.getAttribute("aria-pressed")).toBe("true");
    suggested.click();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("aws", true);
    expect(onSelectOs).toHaveBeenCalledExactlyOnceWith("linux");
    update({ ...params, selectedId: "aws" });
    expect(find("os:linux")?.getAttribute("data-suggested")).toBeNull();
    expect(find("os:linux")?.getAttribute("aria-pressed")).toBe("true");
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
    const { find } = mountCloudProfiles({
      profile: { machines: [machine] },
      selectedMachine: machine.id,
    });
    const machineLabel = find(`machine:${machine.id}`);
    expect(machineLabel?.classList.contains("new-session-page__fixed-machine")).toBe(true);
    expect(machineLabel?.textContent).toContain(expected);
    expect(machineLabel?.tagName).toBe("SPAN");
  });

  it("forwards configuration choices and disables them while submitting", () => {
    const onSelectMachine = vi.fn();
    const onSelectOs = vi.fn();
    const params = {
      profile: {
        operatingSystems: [linux, { id: "macos", label: "macOS" }],
        machines: [small, { id: "large", label: "Large" }],
      },
      selectedOs: "linux",
      selectedMachine: "small",
      onSelectMachine,
      onSelectOs,
    };
    const { container, find, update } = mountCloudProfiles(params);
    find("machine:large")!.click();
    find("os:macos")!.click();
    expect(onSelectMachine).toHaveBeenCalledExactlyOnceWith("large");
    expect(onSelectOs).toHaveBeenCalledExactlyOnceWith("macos");
    update({ ...params, submitting: true });
    expect([...container.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
  });

  it("omits unavailable OS choices even when they are the current selection", () => {
    const { container, find } = mountCloudProfiles({
      profile: {
        operatingSystems: [
          linux,
          { id: "windows", label: "Windows", disabledReason: "Install WSL2" },
        ],
      },
      selectedOs: "windows",
    });
    const fixedOs = find("os:linux");
    expect(fixedOs).toMatchObject({ textContent: "Linux", tagName: "SPAN" });
    expect(fixedOs?.hasAttribute("aria-pressed")).toBe(false);
    expect(find("os:windows")).toBeNull();
    expect(
      container.querySelector('.new-session-page__cloud-configuration [aria-pressed="true"]'),
    ).toBeNull();
  });

  it.each(["runtime", "profile"] as const)("%s preflight", (scope) => {
    const reason = scope === "runtime" ? "Runtime unavailable" : "Profile unavailable";
    const { find } = mountCloudProfiles({
      profiles: [
        { id: "aws", providerId: "crabbox" },
        { id: "ssh", providerId: "static-ssh" },
      ],
      selectedId: "",
      ...(scope === "runtime"
        ? { disabled: true, disabledReason: reason }
        : {
            profileDisabledReason: (profile: Profile) =>
              profile.id === "aws" ? reason : undefined,
          }),
    });
    expect(find<HTMLButtonElement>("cloud:aws")).toMatchObject({ disabled: true, title: reason });
    if (scope === "profile") {
      expect(find<HTMLButtonElement>("cloud:ssh")).toMatchObject({
        disabled: false,
        title: "Cloud worker provider: static-ssh",
      });
    }
  });
});
