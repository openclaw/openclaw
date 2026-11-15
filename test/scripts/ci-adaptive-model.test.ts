import { expect, it } from "vitest";
import { captureAdaptiveModelRanking } from "../../scripts/lib/ci-adaptive-model.mts";
import { collectTestObservations } from "../../scripts/lib/ci-test-observations.mjs";

const context = {
  repository: "example/project",
  revision: "a".repeat(40),
  tree: "b".repeat(40),
  configDigest: "c".repeat(64),
  lockDigest: "d".repeat(64),
  environmentDigest: "e".repeat(64),
};
const files = ["first", "second"].map((project) => ({
  file: "src/shared/string.test.ts",
  project,
  pool: "threads",
}));
const current = collectTestObservations(
  `[vitest:inventory] ${JSON.stringify({
    version: 1,
    invocation: "run",
    runtime: "node",
    runtimeVersion: "v26.13.0",
    platform: "linux",
    arch: "x64",
    dependencyRoot: "",
    files,
  })}`,
  context,
);
const featureNames = [
  "basenameMatch",
  "pathTokenOverlap",
  "sameDirectory",
  "observedDependency",
  "changedPathCountLog",
];
const model = (tree: unknown, names = featureNames) =>
  Buffer.from(
    JSON.stringify({
      version: 1,
      featureSchema: "native-graph-v1",
      featureNames: names,
      tree,
    }),
  );
const options = () => ({
  current: structuredClone(current),
  baseline: structuredClone(current),
  changedFiles: ["src/shared/string.ts"],
  prior: { memberSha256: "f".repeat(64) },
});

it("scores project-qualified inventory without consuming terminal outcomes or changing order", () => {
  const input = options();
  const first = captureAdaptiveModelRanking(input);
  expect(first.rows).toEqual(
    files.map((file) => ({ ...file, score: 0.9565217391304348, unknownReasons: [] })),
  );
  expect(first.modelSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(first.extractorSha256).toMatch(/^[a-f0-9]{64}$/);
  for (const observation of [input.current, input.baseline]) {
    for (const file of observation.invocations[0]!.files) {
      file.outcome = "failed";
      file.durationMs = 999_999;
    }
  }
  const terminal = captureAdaptiveModelRanking(input);
  expect(terminal.rows).toEqual(first.rows);
  expect(terminal.inputSha256).toBe(first.inputSha256);
  input.changedFiles = ["src/shared/unrelated.ts"];
  const changed = captureAdaptiveModelRanking(input);
  expect(changed.rows.map((row) => row.score)).toEqual([0, 0]);
  expect(changed.inputSha256).not.toBe(first.inputSha256);
  expect(input.current.invocations[0]!.files).toMatchObject(files);
});

it("keeps unknown dependency features unknown and rejects malformed model data", () => {
  const input = options();
  const dependencyTree = { feature: 3, threshold: 0.5, left: { score: 0 }, right: { score: 1 } };
  const missing = captureAdaptiveModelRanking({ ...input, modelBytes: model(dependencyTree) });
  expect(missing.rows.map((row) => [row.score, row.unknownReasons])).toEqual([
    [null, ["missing-prior-dependencies"]],
    [null, ["missing-prior-dependencies"]],
  ]);
  input.baseline.invocations[0]!.complete = true;
  for (const file of input.baseline.invocations[0]!.files) {
    file.complete = true;
    file.dependencies = [file.project === "first" ? "src/shared/string.ts" : "src/other.ts"];
  }
  expect(
    captureAdaptiveModelRanking({ ...input, modelBytes: model(dependencyTree) }).rows.map(
      (row) => row.score,
    ),
  ).toEqual([1, 0]);
  for (const bytes of [
    Buffer.from("not json"),
    model({ score: 2 }),
    model({ score: null }),
    model({ feature: 5, threshold: 0, left: { score: 0 }, right: { score: 1 } }),
    model({ score: 1 }, featureNames.toReversed()),
  ]) {
    const invalid = captureAdaptiveModelRanking({ ...input, modelBytes: bytes });
    expect(invalid.rows.map((row) => [row.score, row.unknownReasons])).toEqual([
      [null, ["model-unavailable-or-invalid"]],
      [null, ["model-unavailable-or-invalid"]],
    ]);
  }
});
