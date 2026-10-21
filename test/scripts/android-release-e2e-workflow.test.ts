import { ok } from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { readCiWorkflow, readWorkflow } from "./ci-workflow.test-support.js";

type Job = {
  permissions?: Record<string, string>;
  with?: Record<string, string>;
  steps?: Array<{ name: string; uses?: string; with?: Record<string, string> }>;
};
type Workflow = { permissions: Record<string, string>; jobs: Record<string, Job> };

const qualification: Workflow = readWorkflow(".github/workflows/android-release-e2e.yml");
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

it("publishes only credential-free qualification evidence", () => {
  const store: Workflow = readWorkflow(".github/workflows/android-store-release.yml");
  const storeQualify = store.jobs.qualify;
  expect(storeQualify.with).toEqual({ target_sha: "${{ github.sha }}" });
  expect(storeQualify.permissions).toEqual({ actions: "read", contents: "read" });
  expect(qualification.permissions).toEqual({ actions: "read", contents: "read" });
  const uploads = qualify.steps?.filter((step) =>
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

it("requires the same immutable Gateway selection on reruns", async () => {
  const script = qualify.steps?.find(
    (step) => step.name === "Find this run's stable Gateway selection",
  )?.with?.script;
  expect(script).toBeDefined();
  const outputs = new Map<string, string>();
  const run = (artifacts: unknown[]) =>
    runInNewContext(`(async () => { ${script} })()`, {
      context: { runId: 123, repo: { owner: "example", repo: "project" } },
      process: { env: { GITHUB_RUN_ATTEMPT: "2", TARGET_SHA: sha } },
      core: { setOutput: (key: string, value: string) => outputs.set(key, value) },
      github: {
        paginate: async () => artifacts,
        rest: { actions: { listWorkflowRunArtifacts: () => undefined } },
      },
    }) as Promise<void>;
  await expect(run([])).rejects.toThrow("no saved stable Gateway selection");
  const artifact = {
    id: 456,
    name: "android-release-gateway-selection-123",
    expired: false,
    workflow_run: { id: 123, head_sha: sha },
  };
  await expect(run([{ ...artifact, expired: true }])).rejects.toThrow("expired");
  await expect(
    run([{ ...artifact, workflow_run: { id: 123, head_sha: "b".repeat(40) } }]),
  ).rejects.toThrow("another source/run");
  await run([artifact]);
  expect(Object.fromEntries(outputs)).toEqual({ create: "false", "artifact-id": "456" });
});
