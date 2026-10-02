import { describe, expect, it } from "vitest";
import type { DraftCloudProfile } from "./discovery.ts";
import { DraftCloudMachineState } from "./draft-cloud-machine-state.ts";

describe("cloud selection intent", () => {
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
