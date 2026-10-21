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

type Row = { id: string; label: boolean; probabilityTrue: number | null };
function tuneRows(tuning: Row[], heldOut: Row[], args: string[] = [], heldOutIdentity = identity) {
  const root = roots.make("decision-tuning-");
  const tuningFile = path.join(root, "tuning.json");
  const heldOutFile = path.join(root, "held-out.json");
  writeFileSync(tuningFile, JSON.stringify({ identity, samples: tuning }));
  writeFileSync(heldOutFile, JSON.stringify({ identity: heldOutIdentity, samples: heldOut }));
  return spawnSync(
    process.execPath,
    [
      "scripts/decision-threshold.mts",
      "tune",
      "--tuning",
      tuningFile,
      "--held-out",
      heldOutFile,
      "--min-precision",
      "0.8",
      "--min-recall",
      "0.8",
      ...args,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
}
const separated: Row[] = [
  { id: "positive", label: true, probabilityTrue: 0.4 },
  { id: "negative", label: false, probabilityTrue: 0.1 },
];
const heldOut: Row[] = [
  { id: "held-positive", label: true, probabilityTrue: 0.45 },
  { id: "held-negative", label: false, probabilityTrue: 0.05 },
];

it("selects below 0.50 on tuning data, then reports held-out results and the default baseline", () => {
  const result = tuneRows(separated, heldOut);
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report).toMatchObject({
    status: "held-out-targets-met",
    selected: { threshold: 0.4, metrics: { precision: 1, recall: 1, fBeta: 1 } },
    heldOut: { precision: 1, recall: 1, fBeta: 1 },
    baseline: { threshold: 0.5, heldOut: { precision: null, recall: 0, fBeta: 0 } },
  });
});

it("does not retune or relax targets after held-out failure", () => {
  const result = tuneRows(separated, [
    { id: "held-positive", label: true, probabilityTrue: 0.2 },
    { id: "held-negative", label: false, probabilityTrue: 0.1 },
  ]);
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout)).toMatchObject({
    status: "held-out-targets-missed",
    selected: { threshold: 0.4 },
    meetsHeldOutTargets: false,
    heldOut: { precision: null, recall: 0, falseNegative: 1 },
  });
});

it.each([
  { rows: separated.map((row) => ({ ...row, probabilityTrue: 0.4 })) },
  { rows: [{ id: "negative-only", label: false, probabilityTrue: 0.1 }] },
  { rows: [{ id: "unavailable", label: true, probabilityTrue: null }] },
])("returns no threshold when constraints cannot be established: %j", ({ rows }) => {
  const result = tuneRows(rows, heldOut);
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout)).toMatchObject({
    status: "no-feasible-threshold",
    selected: null,
    heldOut: null,
    meetsHeldOutTargets: null,
  });
});

it("honors precision versus recall weighting and groups identical scores", () => {
  const rows: Row[] = [
    { id: "p1", label: true, probabilityTrue: 0.9 },
    { id: "p2", label: true, probabilityTrue: 0.2 },
    { id: "n1", label: false, probabilityTrue: 0.2 },
    { id: "n2", label: false, probabilityTrue: 0.1 },
  ];
  for (const [beta, threshold] of [
    ["0.5", 0.9],
    ["2", 0.2],
  ] as const) {
    const result = tuneRows(rows, heldOut, [
      "--min-precision",
      "0",
      "--min-recall",
      "0",
      "--beta",
      beta,
    ]);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).selected.threshold).toBe(threshold);
  }
});

it("rejects overlapping examples and mismatched model or rubric identities", () => {
  const overlap = tuneRows(separated, separated);
  expect(overlap).toMatchObject({ status: 1, stdout: "" });
  expect(overlap.stderr).toContain("overlap");
  const mismatch = tuneRows(separated, heldOut, [], { ...identity, rubricVersion: "2" });
  expect(mismatch).toMatchObject({ status: 1, stdout: "" });
  expect(mismatch.stderr).toContain("identities must match");
});
