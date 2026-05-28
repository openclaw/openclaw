import { describe, expect, it } from "vitest";
import {
  collectCapitalStrategyEquityPositionSizerChecks,
  runCapitalStrategyEquityPositionSizerCheck,
} from "../../scripts/check-capital-strategy-equity-position-sizer.mjs";

describe("check-capital-strategy-equity-position-sizer", () => {
  it("collects passing checks for equity fallback and sizing integration", async () => {
    const report = await collectCapitalStrategyEquityPositionSizerChecks();

    expect(report.ok).toBe(true);
    expect(report.checks.map((entry) => entry.id)).toEqual([
      "equity_bridge_fallback",
      "position_sizer_margin_cap",
      "strategy_engine_equity_integration",
    ]);
    expect(report.checks.every((entry) => entry.status === "pass")).toBe(true);
  });

  it("prints machine-readable success token in run mode", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCapitalStrategyEquityPositionSizerCheck({
      io: {
        stdout: { write: (text: string) => stdout.push(text) },
        stderr: { write: (text: string) => stderr.push(text) },
      },
    });

    expect(exitCode).toBe(0);
    expect(stderr.join("")).toBe("");
    expect(stdout.join("")).toContain("CAPITAL_STRATEGY_EQUITY_POSITION_SIZER_CHECK=OK");
  });
});
