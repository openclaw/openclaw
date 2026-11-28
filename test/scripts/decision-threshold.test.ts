import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const identity = {
  provider: "fixture",
  model: "fixed-v1",
  rubricVersion: "1",
  questionId: "failure",
};

function run(samples: unknown[], args: string[] = ["--threshold", "0.5"]) {
  const file = path.join(roots.make("decision-threshold-"), "scores.json");
  writeFileSync(file, JSON.stringify({ identity, samples }));
  return spawnSync(
    process.execPath,
    ["scripts/decision-threshold.mts", "evaluate", "--data", file, ...args],
    {
      encoding: "utf8",
      timeout: 10_000,
    },
  );
}

it("evaluates an explicit inclusive threshold without converting missing scores to negatives", () => {
  const result = run([
    { id: "tp", label: true, probabilityTrue: 0.5 },
    { id: "fp", label: false, probabilityTrue: 0.9 },
    { id: "tn", label: false, probabilityTrue: 0.1 },
    { id: "fn", label: true, probabilityTrue: 0.4 },
    { id: "unavailable", label: true, probabilityTrue: null },
  ]);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    identity,
    policy: { threshold: 0.5, comparison: "probabilityTrue >= threshold", beta: 1 },
    evaluation: {
      total: 5,
      scored: 4,
      unscored: 1,
      truePositive: 1,
      falsePositive: 1,
      trueNegative: 1,
      falseNegative: 1,
      precision: 0.5,
      recall: 0.5,
      fBeta: 0.5,
    },
  });
});

it("reports undefined precision and recall honestly on a single-class dataset", () => {
  const result = run([{ id: "negative", label: false, probabilityTrue: 0.1 }]);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).evaluation).toMatchObject({
    precision: null,
    recall: null,
    fBeta: null,
  });
});

it.each([
  { samples: [{ id: "bad", label: true, probabilityTrue: 2 }], args: ["--threshold", "0.5"] },
  { samples: [{ id: "missing", label: true }], args: ["--threshold", "0.5"] },
  { samples: [{ id: "bad-label", label: 1, probabilityTrue: 0.4 }], args: ["--threshold", "0.5"] },
  {
    samples: [
      { id: "duplicate", label: false, probabilityTrue: 0 },
      { id: "duplicate", label: true, probabilityTrue: 1 },
    ],
    args: ["--threshold", "0.5"],
  },
  { samples: [{ id: "valid", label: true, probabilityTrue: 1 }], args: [] },
  { samples: [{ id: "valid", label: true, probabilityTrue: 1 }], args: ["--threshold", "NaN"] },
])(
  "rejects invalid scores, labels, duplicate IDs or implicit thresholds: %j",
  ({ samples, args }) => {
    const result = run(samples, args);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain('"probabilityTrue":');
  },
);
