import { describe, expect, it } from "vitest";
import { defaultCloudMachine, type DraftCloudProfile } from "./discovery.ts";
import { DraftCloudMachineState } from "./draft-cloud-machine-state.ts";

describe("cloud selection intent", () => {
  it("prefers a smaller reported machine only for an unconfigured OS-scoped catalog", () => {
    const profile: DraftCloudProfile = {
      id: "cloud",
      providerId: "worker",
      operatingSystems: [{ id: "linux", label: "Linux", default: true }],
      machines: [
        { id: "large", label: "Large", os: "linux", cpu: 32, memoryGb: 64 },
        { id: "small", label: "Small", os: "linux", cpu: 8, memoryGb: 16 },
        { id: "tiny", label: "Tiny", os: "windows", cpu: 2, memoryGb: 4 },
      ],
    };
    const state = new DraftCloudMachineState();
    expect(state.selection(profile.id, [profile])).toEqual({ os: "linux", machineClass: "small" });
    state.select(profile.id, "large", [profile]);
    expect(state.selection(profile.id, [profile])).toEqual({ os: "linux", machineClass: "large" });
  });

  it.each<{ name: string; machines: NonNullable<DraftCloudProfile["machines"]> }>([
    {
      name: "CPU and memory tradeoff",
      machines: [
        { id: "first", label: "First", cpu: 4, memoryGb: 8 },
        { id: "second", label: "Second", cpu: 2, memoryGb: 64 },
      ],
    },
    {
      name: "unknown CPU",
      machines: [
        { id: "first", label: "First", memoryGb: 64 },
        { id: "second", label: "Second", cpu: 2, memoryGb: 8 },
      ],
    },
    {
      name: "unknown memory",
      machines: [
        { id: "first", label: "First", cpu: 32 },
        { id: "second", label: "Second", cpu: 2, memoryGb: 8 },
      ],
    },
    {
      name: "equal reported shapes",
      machines: [
        { id: "first", label: "First", cpu: 2, memoryGb: 8 },
        { id: "second", label: "Second", cpu: 2, memoryGb: 8 },
      ],
    },
  ])("preserves provider order for $name", ({ machines }) => {
    expect(defaultCloudMachine({ id: "cloud", providerId: "worker", machines })?.id).toBe("first");
  });

  it("retains a selected machine and its OS after catalog refresh", () => {
    const profile: DraftCloudProfile = {
      id: "aws",
      providerId: "crabbox",
      operatingSystems: [
        { id: "linux", label: "Linux", default: true },
        { id: "windows/wsl2", label: "Windows" },
      ],
      machines: [
        { id: "small", label: "Small", os: "linux", default: true },
        { id: "standard", label: "Standard", os: "linux" },
      ],
    };
    const state = new DraftCloudMachineState();
    state.select(profile.id, "small", [profile]);
    profile.operatingSystems = [
      { id: "linux", label: "Linux" },
      { id: "windows/wsl2", label: "Windows", default: true },
    ];
    profile.machines = [
      { id: "standard", label: "Standard", os: "linux", default: true },
      { id: "small", label: "Small", os: "linux" },
    ];

    expect(state.selectedOs(profile)).toBe("linux");
    expect(state.resolve(profile.id)).toBe("small");
    expect(state.selection(profile.id, [profile])).toEqual({
      os: "linux",
      machineClass: "small",
    });
  });

  it("uses OS-scoped configured defaults without substituting a class named Small", () => {
    const profile: DraftCloudProfile = {
      id: "aws",
      providerId: "crabbox",
      operatingSystems: [
        { id: "linux", label: "Linux", default: true },
        { id: "windows/wsl2", label: "Windows" },
      ],
      machines: [
        { id: "small", label: "Small", os: "linux", cpu: 4, memoryGb: 8 },
        { id: "standard", label: "Standard", os: "linux", default: true, cpu: 32, memoryGb: 64 },
        { id: "small", label: "Small", os: "windows/wsl2", cpu: 4, memoryGb: 16 },
        {
          id: "standard",
          label: "Standard",
          os: "windows/wsl2",
          default: true,
          cpu: 2,
          memoryGb: 8,
        },
      ],
    };
    const state = new DraftCloudMachineState();
    expect(state.selection(profile.id, [profile])).toEqual({
      os: "linux",
      machineClass: "standard",
    });
    state.selectOs(profile.id, "windows/wsl2", [profile]);
    expect(state.selection(profile.id, [profile])).toEqual({
      os: "windows/wsl2",
      machineClass: "standard",
    });
    expect(state.selection("optionless", [{ id: "optionless", providerId: "crabbox" }])).toEqual({
      os: "",
      machineClass: "",
    });
  });
});
