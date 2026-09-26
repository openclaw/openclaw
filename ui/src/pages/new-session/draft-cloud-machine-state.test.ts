import { describe, expect, it } from "vitest";
import type { DraftCloudProfile } from "./discovery.ts";
import { DraftCloudMachineState } from "./draft-cloud-machine-state.ts";

describe("cloud selection intent", () => {
  it.each([
    { name: "unknown Small dimensions", smallCpu: undefined, fallbackCpu: 32, expected: "small" },
    { name: "oversized Small mapping", smallCpu: 16, fallbackCpu: 2, expected: "custom" },
    { name: "missing Small class", smallCpu: null, fallbackCpu: 4, expected: "custom" },
    { name: "no small shape available", smallCpu: null, fallbackCpu: 32, expected: "standard" },
  ])("uses available catalog facts for $name", ({ smallCpu, fallbackCpu, expected }) => {
    const profile: DraftCloudProfile = {
      id: "cloud",
      providerId: "crabbox",
      machines: [
        { id: "custom", label: "Custom", cpu: fallbackCpu },
        { id: "standard", label: "Standard", cpu: 32, default: true },
        ...(smallCpu === null ? [] : [{ id: "small", label: "Small", cpu: smallCpu }]),
      ],
    };
    const state = new DraftCloudMachineState();
    expect(state.selection(profile.id, [profile]).machineClass).toBe(expected);
    state.select(profile.id, "standard", [profile]);
    expect(state.selection(profile.id, [profile]).machineClass).toBe("standard");
  });

  it.each([false, true])(
    "retains a selected machine and its OS after catalog refresh (explicit OS: %s)",
    (selectOs) => {
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
      if (selectOs) {
        state.selectOs(profile.id, "linux", [profile]);
      }
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
    },
  );

  it("preselects Small per OS instead of a configured Standard class", () => {
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
      machineClass: "small",
    });
    state.selectOs(profile.id, "windows/wsl2", [profile]);
    expect(state.selection(profile.id, [profile])).toEqual({
      os: "windows/wsl2",
      machineClass: "small",
    });
    expect(state.selection("optionless", [{ id: "optionless", providerId: "crabbox" }])).toEqual({
      os: "",
      machineClass: "",
    });
  });
});
