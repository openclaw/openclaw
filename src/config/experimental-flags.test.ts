import { describe, expect, it } from "vitest";
import {
  applyExperimentalConfigFlagValue,
  applyExperimentalConfigSelection,
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

  it("writes explicit false when disabling an absent experimental flag", () => {
    const { nextConfig, delta } = applyExperimentalConfigFlagValue(
      {},
      { path: "tools.experimental.planTool", value: false },
    );

    expect(delta).toMatchObject({ path: "tools.experimental.planTool", next: false });
    expect(nextConfig).toEqual({ tools: { experimental: { planTool: false } } });
  });

  it("keeps explicit false no-op behavior for authored disabled flags", () => {
    const root = { tools: { experimental: { planTool: false } } };
    const { nextConfig, delta } = applyExperimentalConfigFlagValue(root, {
      path: "tools.experimental.planTool",
      value: false,
    });

    expect(delta).toBeNull();
    expect(nextConfig).toEqual(root);
  });

  it("writes explicit false for absent unselected picker flags", () => {
    const { nextConfig, deltas } = applyExperimentalConfigSelection(
      {},
      new Set(["agents.defaults.experimental.localModelLean"]),
    );

    expect(deltas.map((delta) => ({ path: delta.path, next: delta.next }))).toEqual([
      { path: "agents.defaults.experimental.localModelLean", next: true },
      { path: "agents.defaults.memorySearch.experimental.sessionMemory", next: false },
      { path: "tools.experimental.planTool", next: false },
    ]);
    expect(nextConfig).toMatchObject({
      agents: {
        defaults: {
          experimental: {
            localModelLean: true,
          },
          memorySearch: { experimental: { sessionMemory: false } },
        },
      },
      tools: { experimental: { planTool: false } },
    });
  });
});
