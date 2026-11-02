/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { SessionMenuItem } from "./cloud-target-view.tsx";
import { mountCloudProfiles } from "./cloud-target.test-support.ts";
import { requestPlaceCatalog } from "./cloud-target.ts";
import {
  projectDevicePlacements,
  resolveAutomaticDevicePlacementDisabledReason,
} from "./device-placement.ts";

type CloudParams = Parameters<typeof mountCloudProfiles>[0];
function cloud(params: Partial<CloudParams>) {
  const container = document.createElement("div");
  const initial = {
    selectedId: "aws",
    submitting: false,
    onSelect: vi.fn(),
    profiles: [],
    ...params,
  };
  const mounted = mountCloudProfiles(initial, container);
  return {
    container,
    find: (value: string) => container.querySelector<HTMLButtonElement>(`[data-value="${value}"]`),
    update: (changes: Partial<CloudParams>) => mounted.update({ ...initial, ...changes }),
  };
}

describe("cloud target menu", () => {
  it("orders Gateway catalogs while retaining placement facts and omitting unsupported kinds", async () => {
    const machine = { id: "small", label: "Small", cpu: 2, memoryGb: 4 };
    const profile = { id: "zeta", providerId: "crabbox", machines: [machine] };
    const environment = { id: "node:zeta", type: "node", status: "available" };
    const request = vi.fn().mockResolvedValue({
      profiles: [
        profile,
        { id: "alpha", providerId: "crabbox" },
        { id: "denied", providerId: "crabbox" },
      ],
      dispatchableProfileIds: ["alpha", "zeta"],
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
    expect(catalog.profiles[1]).toEqual({
      id: "zeta",
      providerId: "crabbox",
      machines: [{ id: "small", label: "Small", cpu: 2, memoryGb: 4 }],
    });
  });

  it("renders saved-pairing remediation commands without redeeming a new join URL", () => {
    const { container } = mountSolid(() =>
      createComponent(SessionMenuItem, {
        item: {
          value: "device:disabled",
          label: "Device",
          compact: true,
          disabled: true,
          checked: false,
          onSelect: vi.fn(),
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
    expect(
      resolveAutomaticDevicePlacementDisabledReason(
        environments,
        projectDevicePlacements(environments),
      ),
    ).toBe(
      "No devices have session hosting enabled. Connect a machine with session hosting enabled, or enable it on a paired device.",
    );
  });

  it("selects suggested defaults before editing provider configuration and disables submission edits", () => {
    const onSelect = vi.fn();
    const onSelectOs = vi.fn();
    const onSelectMachine = vi.fn();
    const { update, find, container } = cloud({
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
      onSelectMachine,
    });
    const suggested = find("os:linux")!;
    expect(suggested.dataset.suggested).toBe("true");
    expect(suggested.getAttribute("aria-pressed")).toBe("true");
    expect(find("machine:small")?.getAttribute("aria-pressed")).toBe("true");
    suggested.click();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("aws", true);
    expect(onSelectOs).toHaveBeenCalledExactlyOnceWith("linux");
    update({ selectedId: "aws" });
    expect(find("os:linux")?.getAttribute("data-suggested")).toBeNull();
    expect(find("os:linux")?.getAttribute("aria-pressed")).toBe("true");
    onSelectOs.mockClear();
    find("machine:standard")!.click();
    find("os:windows")!.click();
    expect(onSelectMachine).toHaveBeenCalledExactlyOnceWith("standard");
    expect(onSelectOs).toHaveBeenCalledExactlyOnceWith("windows");
    update({ selectedId: "aws", submitting: true });
    expect([...container.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
  });

  it.each([
    [{ cpu: 32, memoryGb: 64 }, "32 vCPU · 64 GB"],
    [{ cpu: 48 }, "48 vCPU"],
    [{ memoryGb: 256 }, "256 GB"],
    [{}, "Custom"],
  ] as const)("renders a single machine as fixed configuration: %j", (shape, expected) => {
    const machine = { id: "fixed", label: "Custom", ...shape };
    const { find } = cloud({
      profiles: [{ id: "aws", providerId: "aws", machines: [machine] }],
      selectedMachine: machine.id,
    });
    const machineLabel = find(`machine:${machine.id}`);
    expect(machineLabel?.classList.contains("new-session-page__fixed-machine")).toBe(true);
    expect(machineLabel?.textContent).toContain(expected);
    expect(machineLabel?.tagName).toBe("SPAN");
  });

  it("omits unavailable OS choices even when they are the current selection", () => {
    const { find, container } = cloud({
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
    const fixedOs = find("os:linux");
    expect(fixedOs?.textContent).toBe("Linux");
    expect(fixedOs?.tagName).toBe("SPAN");
    expect(fixedOs?.hasAttribute("aria-pressed")).toBe(false);
    expect(find("os:windows")).toBeNull();
    expect(
      container.querySelector('.new-session-page__cloud-configuration [aria-pressed="true"]'),
    ).toBeNull();
  });

  it.each([true, false])("disables cloud profiles with a runtime-wide blocker: %s", (global) => {
    const reason = "This runtime cannot use the cloud worker.";
    const { find } = cloud({
      profiles: [
        { id: "aws", providerId: "crabbox" },
        { id: "ssh", providerId: "static-ssh" },
      ],
      selectedId: "",
      disabled: global,
      disabledReason: reason,
      profileDisabledReason: global
        ? undefined
        : (profile) => (profile.id === "aws" ? reason : undefined),
    });

    const disabled = find("cloud:aws");
    const enabled = find("cloud:ssh");
    expect(disabled?.getAttribute("aria-disabled")).toBe("true");
    expect(disabled?.getAttribute("aria-description")).toContain(reason);
    expect(enabled?.disabled).toBe(false);
    expect(enabled?.getAttribute("aria-disabled")).toBe(global ? "true" : null);
    expect(enabled?.getAttribute("aria-description")).toBe(
      `Cloud worker provider: static-ssh${global ? `, ${reason}` : ""}`,
    );
  });
});
