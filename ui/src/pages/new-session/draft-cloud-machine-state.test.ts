import { describe, expect, it } from "vitest";
import { defaultCloudMachine, type DraftCloudProfile } from "./discovery.ts";
import { DraftCloudMachineState } from "./draft-cloud-machine-state.ts";

type Machine = NonNullable<DraftCloudProfile["machines"]>[number];
const machine = (id: string, shape: Partial<Omit<Machine, "id" | "label">> = {}): Machine => ({
  id,
  label: id[0]!.toUpperCase() + id.slice(1),
  ...shape,
});
const profile = (machines: Machine[]): DraftCloudProfile => ({
  id: "cloud",
  providerId: "worker",
  machines,
  operatingSystems: [
    { id: "linux", label: "Linux", default: true },
    { id: "windows/wsl2", label: "Windows" },
  ],
});

function expectSelection(
  state: DraftCloudMachineState,
  selected: DraftCloudProfile,
  os: string,
  machineClass: string,
) {
  expect(state.selection(selected.id, [selected])).toEqual({ os, machineClass });
}

describe("cloud selection intent", () => {
  it("prefers a smaller reported machine only for an unconfigured OS-scoped catalog", () => {
    const selected = profile([
      machine("large", { os: "linux", cpu: 32, memoryGb: 64 }),
      machine("small", { os: "linux", cpu: 8, memoryGb: 16 }),
      machine("tiny", { os: "windows", cpu: 2, memoryGb: 4 }),
    ]);
    const state = new DraftCloudMachineState();
    expectSelection(state, selected, "linux", "small");
    state.select(selected.id, "large", [selected]);
    expectSelection(state, selected, "linux", "large");
  });

  it.each([
    ["CPU and memory tradeoff", { cpu: 4, memoryGb: 8 }, { cpu: 2, memoryGb: 64 }],
    ["unknown CPU", { memoryGb: 64 }, { cpu: 2, memoryGb: 8 }],
    ["unknown memory", { cpu: 32 }, { cpu: 2, memoryGb: 8 }],
    ["equal reported shapes", { cpu: 2, memoryGb: 8 }, { cpu: 2, memoryGb: 8 }],
  ] as const)("preserves provider order for %s", (_name, first, second) => {
    expect(
      defaultCloudMachine({
        id: "cloud",
        providerId: "worker",
        machines: [machine("first", first), machine("second", second)],
      })?.id,
    ).toBe("first");
  });

  it("retains a selected machine and its OS after catalog refresh", () => {
    const selected = profile([
      machine("small", { os: "linux", default: true }),
      machine("standard", { os: "linux" }),
    ]);
    const state = new DraftCloudMachineState();
    state.select(selected.id, "small", [selected]);
    selected.operatingSystems = [
      { id: "linux", label: "Linux" },
      { id: "windows/wsl2", label: "Windows", default: true },
    ];
    selected.machines = [
      machine("standard", { os: "linux", default: true }),
      machine("small", { os: "linux" }),
    ];

    expect(state.selectedOs(selected)).toBe("linux");
    expect(state.resolve(selected.id)).toBe("small");
    expectSelection(state, selected, "linux", "small");
  });

  it("uses OS-scoped configured defaults without substituting a class named Small", () => {
    const selected = profile([
      machine("small", { os: "linux", cpu: 4, memoryGb: 8 }),
      machine("standard", { os: "linux", default: true, cpu: 32, memoryGb: 64 }),
      machine("small", { os: "windows/wsl2", cpu: 4, memoryGb: 16 }),
      machine("standard", { os: "windows/wsl2", default: true, cpu: 2, memoryGb: 8 }),
    ]);
    const state = new DraftCloudMachineState();
    expectSelection(state, selected, "linux", "standard");
    state.selectOs(selected.id, "windows/wsl2", [selected]);
    expectSelection(state, selected, "windows/wsl2", "standard");
    expect(state.selection("optionless", [{ id: "optionless", providerId: "crabbox" }])).toEqual({
      os: "",
      machineClass: "",
    });
  });
});
