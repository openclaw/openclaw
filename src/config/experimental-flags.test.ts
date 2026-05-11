import { describe, expect, it } from "vitest";
import {
  listExperimentalConfigFlags,
  resolveExperimentalConfigFlag,
} from "./experimental-flags.js";

describe("experimental config flags", () => {
  it("derives the configurable experimental subset from boolean config schema leaves", () => {
    const flags = listExperimentalConfigFlags();

    expect(flags.map((flag) => flag.path)).toEqual([
      "agents.defaults.experimental.localModelLean",
      "agents.defaults.memorySearch.experimental.sessionMemory",
      "tools.experimental.planTool",
    ]);
    expect(flags.map((flag) => flag.path)).not.toContain("agents.defaults.experimental");
    expect(flags.map((flag) => flag.path)).not.toContain("tools.experimental");
  });

  it("uses schema labels and descriptions for display metadata", () => {
    const flags = listExperimentalConfigFlags();

    for (const flag of flags) {
      expect(flag.label, flag.path).toBeTruthy();
      expect(flag.summary, flag.path).toBeTruthy();
      expect(flag.summary, flag.path).not.toBe(flag.path);
    }
    expect(flags.find((flag) => flag.path === "tools.experimental.planTool")?.label).toBe(
      "Enable Structured Plan Tool",
    );
    expect(
      flags.find((flag) => flag.path === "agents.defaults.memorySearch.experimental.sessionMemory")
        ?.summary,
    ).toContain("Indexes session transcripts");
  });

  it("resolves only the known experimental subset", () => {
    expect(resolveExperimentalConfigFlag("tools.experimental.planTool")?.path).toBe(
      "tools.experimental.planTool",
    );
    expect(resolveExperimentalConfigFlag("localModelLean")?.path).toBe(
      "agents.defaults.experimental.localModelLean",
    );
    expect(resolveExperimentalConfigFlag("tools.experimental")).toBeUndefined();
  });
});
