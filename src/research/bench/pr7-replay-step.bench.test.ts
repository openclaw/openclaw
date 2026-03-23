import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createReplayRun, stepReplayRun } from "../../replay/control/runner.js";

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.toSorted((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[idx];
}

describe("pr7 replay bench", () => {
  it("keeps recorded step latency under budget", async () => {
    if (process.env.OPENCLAW_BENCH !== "1") {
      return;
    }
    const fixturePath = path.join(
      process.cwd(),
      "src",
      "research",
      "contracts",
      "__fixtures__",
      "trajectory",
      "v1",
      "small.json",
    );
    const budgetsPath = path.join(process.cwd(), "src", "research", "bench", "budgets.v1.json");
    const budgets = JSON.parse(await fs.readFile(budgetsPath, "utf8")) as Record<string, number>;
    const budgetMs = budgets["pr7.replay.step.p95Ms"] ?? 50;

    const samples: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      const run = await createReplayRun({
        runId: `bench-${i}`,
        request: { trajectoryPath: fixturePath, mode: "recorded" },
      });
      const start = performance.now();
      stepReplayRun({ run });
      samples.push(performance.now() - start);
    }
    const p95 = percentile(samples, 0.95);
    expect(p95).toBeLessThanOrEqual(budgetMs);
  });
});
