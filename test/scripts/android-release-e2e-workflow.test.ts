import { ok } from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { readCiWorkflow, readWorkflow } from "./ci-workflow.test-support.js";

type Job = {
  if?: string;
  needs?: string;
  permissions?: Record<string, string>;
  with?: Record<string, string>;
  steps?: Array<{ name: string; uses?: string; with?: Record<string, string> }>;
};
type Workflow = { permissions: Record<string, string>; jobs: Record<string, Job> };

const qualification = readWorkflow(".github/workflows/android-release-e2e.yml") as Workflow;
const qualify = qualification.jobs.qualify;
ok(qualify, "Android validation must have its qualification job");
const selectionDir = "${{ env.GATEWAY_SELECTION_DIR }}";
const runnerTemp = "${{ runner.temp }}";

function admission(condition: string, context: Record<string, unknown>) {
  return expect(Boolean(runInNewContext(condition.replace(/^\$\{\{\s*|\s*\}\}$/gu, ""), context)));
}

const sha = "a".repeat(40);

it.each([
  { change: {}, selected: true },
  { change: { event_name: "push" }, selected: false },
  { change: { event_name: "schedule" }, selected: false },
  { change: { release_gate: true }, selected: false },
  { change: { validation_tier: "main" }, selected: false },
  { change: { release_scope: "npm" }, selected: false },
  { change: { checkout_revision: "b".repeat(40) }, selected: false },
  { change: { compatibility_target: "true" }, selected: false },
  { change: { run_android_job: "false" }, selected: false },
])("admits only the selected full manual source: $change", ({ change, selected }) => {
  const job = readCiWorkflow().jobs["android-release-e2e"];
  const defaults = {
    event_name: "workflow_dispatch",
    release_gate: false,
    validation_tier: "full",
    release_scope: "full",
    checkout_revision: sha,
    compatibility_target: "false",
    run_android_job: "true",
    ...change,
  };
  admission(job.if, {
    github: { event_name: defaults.event_name, sha },
    inputs: { release_gate: defaults.release_gate },
    needs: { preflight: { outputs: defaults } },
  }).toBe(selected);
});

it.each(["success", "failure", "cancelled", "skipped"])(
  "gates store signing/upload on qualification: %s",
  (result) => {
    const { qualify: storeQualify, release } = (
      readWorkflow(".github/workflows/android-store-release.yml") as Workflow
    ).jobs;
    ok(storeQualify, "Android store release must have its qualification job");
    ok(release, "Android store release must have its release job");
    const context = {
      github: {
        event_name: "workflow_dispatch",
        ref: "refs/heads/main",
        repository: "openclaw/openclaw",
      },
      inputs: { operation: "release" },
      needs: { qualify: { result } },
      vars: {},
      cancelled: () => false,
    };
    admission(storeQualify.if ?? "", context).toBe(true);
    expect(release.needs).toBe("qualify");
    admission(release.if ?? "", context).toBe(result === "success");
    expect(storeQualify.with).toEqual({ target_sha: "${{ github.sha }}" });
    expect(storeQualify.permissions).toEqual({ actions: "read", contents: "read" });
  },
);

it("publishes only credential-free qualification evidence", () => {
  expect(qualification.permissions).toEqual({ actions: "read", contents: "read" });
  const selection = readWorkflow(".github/actions/prepare-mobile-release-gateway/action.yml") as {
    runs: { steps: NonNullable<Job["steps"]> };
  };
  const prepare = qualify.steps?.find(
    (step) => step.uses === "./.github/actions/prepare-mobile-release-gateway",
  );
  expect(prepare?.with).toEqual({
    "artifact-name": "android-release-gateway-selection-${{ github.run_id }}",
  });
  const uploads = [...selection.runs.steps, ...(qualify.steps ?? [])].filter((step) =>
    step.uses?.startsWith("actions/upload-artifact@"),
  );
  expect(uploads?.map((step) => step.with?.path?.trim().split("\n"))).toEqual([
    ["selection.json", "package.json", "package-lock.json"].map(
      (file) => `${selectionDir}/${file}`,
    ),
    [
      `${runnerTemp}/android-release-e2e-proof.json`,
      `${runnerTemp}/android-release-e2e/screenshots/*.png`,
    ],
  ]);
});
