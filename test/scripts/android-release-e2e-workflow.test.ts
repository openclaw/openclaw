import { ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { readCiWorkflow } from "./ci-workflow.test-support.js";

type Workflow = {
  permissions: Record<string, string>;
  jobs: Record<
    string,
    {
      if?: string;
      needs?: string;
      uses?: string;
      permissions?: Record<string, string>;
      with?: Record<string, string>;
      steps?: Array<{ name: string; uses?: string; with?: Record<string, string> }>;
    }
  >;
};

function readWorkflow(filename: string): Workflow {
  return parse(readFileSync(`.github/workflows/${filename}`, "utf8")) as Workflow;
}

function evaluateAdmission(condition: string, context: Record<string, unknown>): boolean {
  return Boolean(runInNewContext(condition.replace(/^\$\{\{\s*|\s*\}\}$/gu, ""), context));
}

describe("Android release validation admission", () => {
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
  ])("qualifies only the selected full manual source: $change", ({ change, selected }) => {
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
    expect(
      evaluateAdmission(job.if, {
        github: { event_name: defaults.event_name, sha },
        inputs: { release_gate: defaults.release_gate },
        needs: { preflight: { outputs: defaults } },
      }),
    ).toBe(selected);
  });

  it.each(["success", "failure", "cancelled", "skipped"])(
    "admits store signing/upload only after qualification success: %s",
    (result) => {
      const workflow = readWorkflow("android-store-release.yml");
      const qualify = workflow.jobs.qualify;
      const release = workflow.jobs.release;
      ok(qualify, "Android store release must have its qualification job");
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
      expect(evaluateAdmission(qualify.if ?? "", context)).toBe(true);
      expect(release.needs).toBe("qualify");
      expect(evaluateAdmission(release.if ?? "", context)).toBe(result === "success");
      expect(qualify.with).toEqual({ target_sha: "${{ github.sha }}" });
      expect(qualify.permissions).toEqual({ actions: "read", contents: "read" });
    },
  );

  it("keeps qualification credential-free and publishes only its public evidence", () => {
    const workflow = readWorkflow("android-release-e2e.yml");
    expect(workflow.permissions).toEqual({ actions: "read", contents: "read" });
    const qualify = workflow.jobs.qualify;
    ok(qualify, "Android validation must have its qualification job");
    const uploads = qualify.steps?.filter((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    expect(uploads?.map((step) => step.with?.path?.trim().split("\n"))).toEqual([
      [
        "${{ env.GATEWAY_SELECTION_DIR }}/selection.json",
        "${{ env.GATEWAY_SELECTION_DIR }}/package.json",
        "${{ env.GATEWAY_SELECTION_DIR }}/package-lock.json",
      ],
      [
        "${{ runner.temp }}/android-release-e2e-proof.json",
        "${{ runner.temp }}/android-release-e2e/screenshots/*.png",
      ],
    ]);
  });

  it("rejects reruns without the same immutable Gateway selection", async () => {
    const workflow = readWorkflow("android-release-e2e.yml");
    const qualify = workflow.jobs.qualify;
    ok(qualify, "Android validation must have its qualification job");
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
});
