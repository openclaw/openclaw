import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import {
  comparisonPlanCells,
  distribution,
  inspectOptInFrames,
} from "../../scripts/perf/inline-command-opt-in-analysis.mjs";

describe("inline command benchmark facts", () => {
  it("binds explicit contemporary comparisons without replacing the original control or candidate", () => {
    const candidate = { cwd: "/proof/candidate", source: "1".repeat(40), tree: "2".repeat(40) };
    type Cell = typeof candidate & { label: string; role: string; inline: boolean };
    const plan = (): { contractId: string; cells: [Cell, Cell, Cell] } => ({
      contractId: "contemporary-main-v1",
      cells: [
        {
          label: "upstream-grouped",
          role: "upstream",
          cwd: "/proof/main",
          source: "3".repeat(40),
          tree: "4".repeat(40),
          inline: false,
        },
        { ...candidate, label: "candidate-grouped", role: "candidate", inline: false },
        { ...candidate, label: "candidate-inline", role: "candidate", inline: true },
      ],
    });
    expect(comparisonPlanCells(plan(), candidate)).toMatchObject([
      { label: "upstream-grouped", integration: true },
      { label: "candidate-grouped", integration: false },
      { label: "candidate-inline", integration: false },
    ]);
    const anchored = plan();
    anchored.cells.push({
      label: "control-grouped",
      role: "control",
      cwd: "/proof/control",
      inline: false,
      source: "454004eab143e6bb25ee95f905fa650173e0c4a4",
      tree: "5".repeat(40),
    });
    expect(comparisonPlanCells(anchored, candidate).at(-1)).toMatchObject({ control: true });
    for (const change of [
      (value: ReturnType<typeof plan>) => {
        value.contractId = "";
      },
      (value: ReturnType<typeof plan>) => {
        value.cells.shift();
      },
      (value: ReturnType<typeof plan>) => {
        value.cells.push({ ...value.cells[0] });
      },
      (value: ReturnType<typeof plan>) => {
        value.cells[0].role = "candidate";
      },
      (value: ReturnType<typeof plan>) => {
        value.cells[0].inline = true;
      },
      (value: ReturnType<typeof plan>) => {
        value.cells[0].source = "floating-main";
      },
      (value: ReturnType<typeof plan>) => {
        value.cells[0].tree = "floating-tree";
      },
      (value: ReturnType<typeof plan>) => {
        value.cells[1].cwd = "relative";
      },
      (value: ReturnType<typeof plan>) => {
        value.cells[1].source = "6".repeat(40);
      },
      (value: ReturnType<typeof plan>) => {
        value.cells[2].tree = "7".repeat(40);
      },
    ]) {
      const value = plan();
      change(value);
      expect(() => comparisonPlanCells(value, candidate)).toThrow();
    }
    const originalControl = anchored.cells.at(-1);
    assert(originalControl);
    originalControl.source = "8".repeat(40);
    expect(() => comparisonPlanCells(anchored, candidate)).toThrow(
      "Original control cannot be replaced",
    );
  });

  it("rejects nonfinite measurements and reports nearest-rank distributions", () => {
    expect(() => distribution([1, Number.NaN])).toThrow();
    expect(distribution([0, 2, 4, 6])).toMatchObject({ median: 3, p95: 6, spread: 6 });
  });

  it("keeps startup stalls and timestamp-only gaps separate from actual callback spacing", () => {
    const result = inspectOptInFrames({
      sendAt: 0,
      warmStartAt: 100,
      endAt: 142,
      frameCallbacks: [
        { timestamp: 10, callbackAt: 60, callbackEndAt: 61, warm: false },
        { timestamp: 70, callbackAt: 80, callbackEndAt: 81, warm: false },
        { timestamp: 100, callbackAt: 110, callbackEndAt: 111, warm: true },
        { timestamp: 120, callbackAt: 130, callbackEndAt: 131, warm: true },
      ],
      tasks: [{ at: 1, duration: 55 }],
    });
    expect(result.actualTails).toEqual([
      expect.objectContaining({ period: "startup-first-callback", actualMs: 60 }),
    ]);
    expect(result.animationTimestampTails).toEqual([
      expect.objectContaining({ animationTimestampMs: 60, actualMs: 20 }),
    ]);
    expect(result.longTasks).toEqual([
      expect.objectContaining({ period: "startup-or-boundary", duration: 55 }),
    ]);
  });
});
