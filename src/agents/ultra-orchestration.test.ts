import { describe, expect, it } from "vitest";
import { buildProactiveSubagentOrchestrationSection } from "./ultra-orchestration.js";

const spawnOnly = [
  "## Proactive Sub-Agent Orchestration",
  "Ultra active for this turn. Plan the work, carry it through, and verify the result before replying.",
  "Use `sessions_spawn` when independent work improves speed/quality.",
  "- Parallelize independent investigation, implementation, verification.",
  "- Simple/tightly coupled stays local.",
  "- Give bounded objectives; synthesize results before replying.",
  "",
];

describe("Ultra orchestration guidance", () => {
  it("renders the existing guidance unchanged without native delegation tools", () => {
    for (const nativeDelegationTools of [undefined, []]) {
      expect(
        buildProactiveSubagentOrchestrationSection({
          enabled: true,
          hasSessionsSpawn: true,
          nativeDelegationTools,
        }),
      ).toEqual(spawnOnly);
      expect(
        buildProactiveSubagentOrchestrationSection({
          enabled: true,
          hasSessionsSpawn: false,
          nativeDelegationTools,
        }),
      ).toEqual([
        "## Ultra Execution",
        "Ultra active for this turn. Plan the work, carry it through, and verify the result before replying.",
        "",
      ]);
    }
  });

  it("names operator-kept native delegation tools beside sessions_spawn", () => {
    const nativeDelegationTools = ["Agent", "Workflow"];
    expect(
      buildProactiveSubagentOrchestrationSection({
        enabled: true,
        hasSessionsSpawn: true,
        nativeDelegationTools,
      })[2],
    ).toBe(
      "Use `sessions_spawn` or native `Agent` or native `Workflow` when independent work improves speed/quality.",
    );
    const nativeOnly = buildProactiveSubagentOrchestrationSection({
      enabled: true,
      hasSessionsSpawn: false,
      nativeDelegationTools: ["Agent"],
    });
    expect(nativeOnly[0]).toBe("## Proactive Sub-Agent Orchestration");
    expect(nativeOnly[2]).toBe("Use native `Agent` when independent work improves speed/quality.");
  });

  it("stays empty when Ultra is off", () => {
    expect(
      buildProactiveSubagentOrchestrationSection({
        enabled: false,
        hasSessionsSpawn: true,
        nativeDelegationTools: ["Agent"],
      }),
    ).toEqual([]);
  });
});
