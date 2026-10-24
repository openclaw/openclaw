import { spawnSync } from "node:child_process";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  readCiWorkflow,
  readWorkflowOutputs,
  requiredWorkflowStep,
  evaluateWorkflow,
  type WorkflowStep,
} from "./ci-workflow.test-support.js";

type Step = WorkflowStep & { "timeout-minutes"?: number };
const job = readCiWorkflow().jobs["macos-swift"];
const steps: Step[] = job.steps;
const temps = useAutoCleanupTempDirTracker(afterEach);
const step = (name: string) => requiredWorkflowStep(steps, name);
const clock = step("Start Swift cache clock");
const budget = step("Check Swift cache save budget");
const packageSave = step("Save SwiftPM cache");
const metadata = step("Record Swift build input timestamps");
const buildSave = step("Save Swift build directory cache");

function runClockStep(owner: Step, now: number, started = "") {
  const output = path.join(temps.make("swift-cache-budget-"), "output");
  const code = owner.run?.match(/^python3 -I -S - <<'PYTHON'\n([\s\S]*)\nPYTHON\n?$/)?.[1];
  const script = `import time\ntime.monotonic = lambda: ${now}\n${code}`;
  const result = spawnSync("python3", ["-I", "-S", "-c", script], {
    encoding: "utf8",
    env: { ...process.env, CACHE_STARTED: started, GITHUB_OUTPUT: output },
  });
  expect(result.status, result.stderr).toBe(0);
  return readWorkflowOutputs(output);
}

type Context = Partial<
  Record<"cacheMode" | "allowed" | "phase" | "primary" | "metadataOutcome", string> &
    Record<"authorized" | "historical" | "hit" | "requiredPassed", boolean>
>;
function selected(owner: Step, context: Context = {}) {
  // These steps intentionally retain Actions' implicit success() condition.
  const outputs = (value: Record<string, string>) => ({ outputs: value });
  const result = runInNewContext((owner.if ?? "true").replace(/\.([a-zA-Z_][\w-]*)/g, '["$1"]'), {
    needs: {
      preflight: outputs({
        cache_mode: context.cacheMode ?? "restore",
        cache_write_allowed: String(context.authorized ?? true),
      }),
    },
    matrix: { phase: context.phase ?? "tests" },
    env: {
      MACOS_PRIMARY_PHASE: context.primary ?? "tests",
      HISTORICAL_TARGET: String(context.historical ?? false),
    },
    steps: {
      "swift-cache-budget": outputs({ allowed: context.allowed ?? "true" }),
      "swiftpm-cache": outputs({ "cache-hit": String(context.hit ?? false) }),
      "swift-build-cache": outputs({ "cache-hit": String(context.hit ?? false) }),
      "record-swift-build-cache-metadata": { outcome: context.metadataOutcome ?? "success" },
    },
  });
  return context.requiredPassed !== false && Boolean(result);
}

it("bounds optional Swift cache writes after required artifacts", () => {
  expect(steps[0]).toBe(clock);
  expect(clock).toMatchObject({ "continue-on-error": true, "timeout-minutes": 1 });
  const started = runClockStep(clock, 1234.5).started;
  expect(started).toBe("1234.5");
  expect(runClockStep(budget, 1235, started).allowed).toBe("true");
  for (const name of [
    "Swift test",
    "Upload default-profile chat menu captures",
    "Upload named-profile chat menu captures",
    "Render isolated macOS health fixtures",
    "Upload macOS health component renders",
  ]) {
    const required = step(name);
    expect(steps.indexOf(required)).toBeLessThan(steps.indexOf(budget));
    expect(required["continue-on-error"]).not.toBe(true);
  }
  expect(budget.env?.CACHE_STARTED).toBe("${{ steps.swift-cache-clock.outputs.started }}");
  const jobTimeout = evaluateWorkflow(job["timeout-minutes"], {
    preflightOutputs: { validation_tier: "main" },
    matrix: { phase: "tests" },
  });
  expect(jobTimeout).toBe(30);
  const tail = [budget, packageSave, metadata, buildSave];
  expect(steps.slice(steps.indexOf(budget))).toEqual(tail);
  let minutes = 0;
  for (const owner of tail) {
    expect(owner["continue-on-error"], owner.name).toBe(true);
    expect(owner["timeout-minutes"], owner.name).toBeGreaterThan(0);
    minutes += owner["timeout-minutes"]!;
  }
  expect(minutes).toBe(5);
  expect(20 + minutes).toBeLessThanOrEqual(jobTimeout - 5);
});

it.each([
  [0, "1000", "true"],
  [1199, "1000", "true"],
  [1200, "1000", "false"],
  [-1, "1000", "false"],
  [1, "", "false"],
  [1, "broken", "false"],
  [1, "nan", "false"],
  [1, "inf", "false"],
])("admits elapsed %s / clock %s as %s", (elapsed, started, expected) => {
  const allowed = runClockStep(budget, 1000 + elapsed, started).allowed;
  expect(allowed).toBe(expected);
  for (const owner of [packageSave, metadata, buildSave]) {
    expect(selected(owner, { allowed }), owner.name).toBe(expected === "true");
  }
});

it.each([packageSave, metadata, buildSave])("guards $name cache writes", (owner) => {
  for (const context of [
    { authorized: false },
    { requiredPassed: false },
    { hit: true },
    { allowed: "" },
  ]) {
    expect(selected(owner, context), JSON.stringify(context)).toBe(false);
  }
  expect(owner.if).not.toMatch(/always\(|failure\(|cancelled\(/);
});

it("retains phase ownership and historical metadata compatibility", () => {
  expect(selected(budget, { phase: "packages" })).toBe(false);
  expect(selected(packageSave, { primary: "release" })).toBe(false);
  expect(selected(packageSave, { primary: "release", phase: "release" })).toBe(true);
  expect(selected(buildSave, { primary: "release" })).toBe(true);
  expect(selected(metadata, { historical: true })).toBe(false);
  expect(selected(buildSave, { historical: true, metadataOutcome: "skipped" })).toBe(true);
});

it("requires successful current-target metadata", () => {
  for (const outcome of ["failure", "cancelled", "skipped", ""]) {
    expect(selected(buildSave, { metadataOutcome: outcome }), outcome).toBe(false);
  }
});

it("keeps pinned cache restore/save ownership, paths, and primary keys", () => {
  for (const [restoreName, save] of [
    ["Restore SwiftPM cache", packageSave],
    ["Restore Swift build directory cache", buildSave],
  ] as const) {
    const restore = step(restoreName);
    for (const phase of ["tests", "release", "packages"]) {
      expect(selected(restore, { phase }), `${restoreName}: ${phase}`).toBe(
        phase !== "packages" || save === packageSave,
      );
      expect(selected(restore, { phase, cacheMode: "off" })).toBe(false);
    }
    expect(restore.uses).toBe("actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9");
    expect(save.uses).toBe("actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9");
    expect(save.with?.path).toBe(restore.with?.path);
    expect(save.with?.key).toBe(`\${{ steps.${restore.id}.outputs.cache-primary-key }}`);
  }
  expect(metadata.run).toBe("python3 -I -S scripts/swift-build-cache-metadata.py record");
});
