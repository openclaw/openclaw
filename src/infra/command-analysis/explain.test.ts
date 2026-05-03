import { describe, expect, it } from "vitest";
import { explainShellCommand } from "../command-explainer/index.js";
import { summarizeCommandExplanation, summarizeCommandSegmentsForDisplay } from "./explain.js";

describe("command-analysis explanation summary", () => {
  it("summarizes commands and risk kinds", async () => {
    const explanation = await explainShellCommand(`bash -lc 'python3 -c "print(1)"'`);
    const summary = summarizeCommandExplanation(explanation);

    expect(summary.commandCount).toBe(1);
    expect(summary.riskKinds).toContain("shell-wrapper");
    expect(summary.riskKinds).toContain("inline-eval");
    expect(summary.warningLines.some((line) => line.includes("inline-eval"))).toBe(true);
  });

  it("summarizes policy command segments without async parsing", () => {
    const summary = summarizeCommandSegmentsForDisplay([
      {
        raw: "sudo python3 -c 'print(1)'",
        argv: ["sudo", "python3", "-c", "print(1)"],
        resolution: null,
      },
    ]);

    expect(summary.commandCount).toBe(1);
    expect(summary.riskKinds).toEqual(["inline-eval"]);
    expect(summary.warningLines).toEqual(["Contains inline-eval: python3 -c"]);
  });
});
