import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  evaluateWorkflowCondition,
  evaluateWorkflow,
  readCiWorkflow,
  readWorkflowOutputs,
  requiredWorkflowStep,
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
const saves = [packageSave, metadata, buildSave];

function runClockStep(owner: Step, now: number, started = "") {
  const output = path.join(temps.make("swift-cache-budget-"), "output");
  const code = owner.run?.match(/^python3 -I -S - <<'PYTHON'\n([\s\S]*)\nPYTHON\n?$/)?.[1];
  const result = spawnSync(
    "python3",
    ["-I", "-S", "-c", `import time\ntime.monotonic = lambda: ${now}\n${code}`],
    {
      encoding: "utf8",
      env: { ...process.env, CACHE_STARTED: started, GITHUB_OUTPUT: output },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return readWorkflowOutputs(output);
}
type Context = Partial<
  Record<"allowed" | "phase" | "primary", string> &
    Record<"authorized" | "historical" | "hit", boolean> & {
      metadataOutcome: "success" | "failure" | "cancelled" | "skipped" | "";
    }
>;
function selected(owner: Step, context: Context = {}) {
  const outputs = (value: Record<string, string>) => ({ outputs: value });
  return evaluateWorkflowCondition(owner.if ?? "true", {
    eventName: "push",
    repository: "openclaw/openclaw",
    runAttempt: 1,
    preflightOutputs: { cache_write_allowed: String(context.authorized ?? true) },
    matrix: { phase: context.phase ?? "tests" },
    env: {
      MACOS_PRIMARY_PHASE: context.primary ?? "tests",
      HISTORICAL_TARGET: String(context.historical ?? false),
    },
    steps: {
      "swift-cache-budget": outputs({ allowed: context.allowed ?? "true" }),
      "swiftpm-cache": outputs({ "cache-hit": String(context.hit ?? false) }),
      "swift-build-cache": outputs({ "cache-hit": String(context.hit ?? false) }),
      "record-swift-build-cache-metadata": {
        outputs: {},
        outcome:
          context.metadataOutcome === "" ? undefined : (context.metadataOutcome ?? "success"),
      },
    },
  });
}

it("bounds the optional cache tail after required Swift work", () => {
  expect(steps[0]).toBe(clock);
  expect(clock).toMatchObject({ "continue-on-error": true, "timeout-minutes": 1 });
  const started = runClockStep(clock, 1234.5).started;
  expect(started).toBe("1234.5");
  expect(runClockStep(budget, 1235, started).allowed).toBe("true");
  expect(budget.env?.CACHE_STARTED).toBe("${{ steps.swift-cache-clock.outputs.started }}");
  const tail = steps.slice(steps.indexOf(budget));
  expect(steps.indexOf(step("Swift test"))).toBeLessThan(steps.indexOf(budget));
  for (const owner of tail) {
    expect(owner["continue-on-error"], owner.name).toBe(true);
    expect(owner["timeout-minutes"], owner.name).toBeGreaterThan(0);
  }
  const minutes = tail.reduce((sum, owner) => sum + owner["timeout-minutes"]!, 0);
  const timeout = evaluateWorkflow(job["timeout-minutes"], {
    preflightOutputs: { validation_tier: "main" },
    matrix: { phase: "tests" },
  });
  expect(20 + minutes).toBeLessThanOrEqual(timeout - 5);
});

it.each([
  [0, "1000", "true"],
  [1199, "1000", "true"],
  [1200, "1000", "false"],
  [-1, "1000", "false"],
  [1, "broken", "false"],
  [1, "nan", "false"],
])("admits elapsed %s / clock %s as %s", (elapsed, started, expected) => {
  const allowed = runClockStep(budget, 1000 + elapsed, started).allowed;
  expect(allowed).toBe(expected);
  for (const owner of saves) {
    expect(selected(owner, { allowed }), owner.name).toBe(expected === "true");
  }
});

it.each(saves)("guards $name cache writes", (owner) => {
  for (const context of [{ authorized: false }, { hit: true }, { allowed: "" }]) {
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

it.each(["failure", "cancelled", "skipped", ""] as const)(
  "refuses current metadata outcome %s",
  (outcome) => {
    expect(selected(buildSave, { metadataOutcome: outcome })).toBe(false);
  },
);

it("saves the restored cache paths and primary keys", () => {
  for (const [restoreName, save] of [
    ["Restore SwiftPM cache", packageSave],
    ["Restore Swift build directory cache", buildSave],
  ] as const) {
    const restore = step(restoreName);
    expect(save.with?.path).toBe(restore.with?.path);
    expect(save.with?.key).toBe(`\${{ steps.${restore.id}.outputs.cache-primary-key }}`);
  }
});
