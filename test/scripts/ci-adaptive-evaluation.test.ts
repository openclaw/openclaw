import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateAdaptiveCapture } from "../../scripts/lib/ci-adaptive-evaluation.mjs";
import { compactTestObservations } from "../../scripts/lib/ci-test-observations.mjs";

function capture() {
  const context = {
    repository: "example/project",
    revision: "a".repeat(40),
    tree: "b".repeat(40),
    configDigest: "c".repeat(64),
    lockDigest: "d".repeat(64),
    environmentDigest: "e".repeat(64),
  };
  const files = ["one", "two"].map((project) => ({
    file: "src/shared.test.ts",
    project,
    pool: "threads",
  }));
  const invocation = {
    id: "test-invocation",
    dependencyRoot: "",
    runtime: "node",
    runtimeVersion: "v24.22.1",
    platform: "linux",
    arch: "x64",
    files: files.map((file, index) => ({
      ...file,
      complete: true,
      outcome: index === 0 ? "passed" : "failed",
      durationMs: 10,
      dependencies: ["src/shared.ts"],
    })),
  };
  const observations = { version: 1, context, invocations: [invocation] };
  const before = structuredClone(observations);
  for (const file of before.invocations[0]!.files) {
    file.complete = false;
    file.outcome = "unknown";
  }
  const scheduledFiles = [...files];
  return {
    version: 1,
    source: { startedAt: "2026-01-01T00:01:00Z", exportedAt: "2026-01-01T00:02:00Z" },
    observations,
    preExecution: {
      recordedAt: "2026-01-01T00:01:01Z",
      observations: before,
      decision: {
        version: 1,
        mode: "shadow",
        recordedAt: "2026-01-01T00:01:01Z",
        prior: { createdAt: "2026-01-01T00:00:00Z" },
        comparison: { revision: "f".repeat(40) },
        scheduledFiles,
        fallbackReasons: [] as string[],
        graph: {
          version: 1,
          mode: "shadow",
          context,
          baselineRevision: "f".repeat(40),
          scheduledFiles,
          candidateFiles: [files[0]],
        },
        ranking: {
          version: 1,
          rows: files.toReversed().map(({ file, project, pool }, index) => ({
            file,
            project,
            pool,
            score: index ? 0.75 : 0.25,
          })),
        },
      },
    },
  };
}

describe("recorded adaptive evaluation", () => {
  it("joins project-qualified predictions to failures without inferring causal labels", () => {
    const input = capture();
    const report = evaluateAdaptiveCapture(input);
    expect(report.outcomes).toEqual({ passed: 1, failed: 1, unknown: 0 });
    expect(report.selection).toEqual({
      selected: 1,
      omitted: 1,
      failedSelected: 0,
      failedOmitted: 1,
      unknown: 0,
    });
    expect(report.failures).toEqual([
      {
        file: "src/shared.test.ts",
        project: "two",
        pool: "threads",
        graphSelected: false,
        recordedScore: 0.25,
        causalStatus: "unattributed",
      },
    ]);
    expect(report.observedCompleteFileMs).toBe(20);
    expect(
      evaluateAdaptiveCapture({
        ...input,
        observations: compactTestObservations(input.observations),
      }),
    ).toEqual(report);
  });

  it("keeps unavailable predictions and incomplete outcomes unknown", () => {
    const input = capture();
    input.observations.invocations[0]!.files[1]!.complete = false;
    const report = evaluateAdaptiveCapture({ ...input, preExecution: undefined });
    expect(report.prediction).toBe("unavailable");
    expect(report.selection).toBeNull();
    expect(report.outcomes).toEqual({ passed: 1, failed: 0, unknown: 1 });
    expect(report.failures).toEqual([]);
    expect(report.scoreBuckets).toEqual([]);
    expect(report.observedCompleteFileMs).toBe(10);
  });

  it.each(["source", "invocation", "root", "inventory", "late", "prior", "score"])(
    "rejects invalid %s evidence",
    (kind) => {
      const input = capture();
      if (kind === "source") {
        input.preExecution.observations.context.revision = "f".repeat(40);
      } else if (kind === "invocation") {
        input.preExecution.observations.invocations[0]!.id = "different-invocation";
      } else if (kind === "root") {
        input.preExecution.observations.invocations[0]!.dependencyRoot = "ui";
      } else if (kind === "inventory") {
        input.preExecution.decision.scheduledFiles = [
          input.preExecution.decision.scheduledFiles[0]!,
        ];
      } else if (kind === "late") {
        input.preExecution.decision.recordedAt = "2026-01-01T00:02:01Z";
      } else if (kind === "prior") {
        input.preExecution.decision.prior.createdAt = "2026-01-01T00:01:01Z";
      } else {
        input.preExecution.decision.ranking.rows[0]!.score = Number.NaN;
      }
      expect(() => evaluateAdaptiveCapture(input)).toThrow();
    },
  );

  it("evaluates an exported capture through the documented command", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "adaptive-evaluation-"));
    try {
      writeFileSync(path.join(dir, "capture.json"), JSON.stringify(capture()));
      execFileSync(process.execPath, [
        "scripts/ci-adaptive-evaluate.mjs",
        "--input",
        path.join(dir, "capture.json"),
        "--output",
        path.join(dir, "report.json"),
      ]);
      expect(
        JSON.parse(readFileSync(path.join(dir, "report.json"), "utf8")).selection.failedOmitted,
      ).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
