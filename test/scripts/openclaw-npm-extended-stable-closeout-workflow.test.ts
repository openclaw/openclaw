import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflowPath = ".github/workflows/openclaw-npm-extended-stable-closeout.yml";

type Step = {
  env?: Record<string, string>;
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
};
type Workflow = {
  on?: { workflow_dispatch?: { inputs?: Record<string, { required?: boolean; type?: string }> } };
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    { environment?: string; permissions?: Record<string, string>; steps?: Step[]; uses?: string }
  >;
};

function workflow(): Workflow {
  return parse(readFileSync(workflowPath, "utf8")) as Workflow;
}

function step(name: string): Step {
  const found = workflow().jobs?.closeout?.steps?.find((candidate) => candidate.name === name);
  if (!found) {
    throw new Error(`Missing workflow step: ${name}`);
  }
  return found;
}

describe("npm extended-stable closeout workflow", () => {
  it("is manual, read-only, and has the five closed inputs", () => {
    const parsed = workflow();
    expect(Object.keys(parsed.on?.workflow_dispatch?.inputs ?? {})).toEqual([
      "tag",
      "preflight_run_id",
      "plugin_npm_run_id",
      "core_npm_run_id",
      "full_release_validation_run_id",
    ]);
    expect(
      Object.values(parsed.on?.workflow_dispatch?.inputs ?? {}).every(
        (input) => input.required === true && input.type === "string",
      ),
    ).toBe(true);
    expect(parsed.permissions).toEqual({ actions: "read", contents: "read" });
    expect(parsed.jobs?.closeout?.environment).toBeUndefined();
    expect(readFileSync(workflowPath, "utf8")).not.toMatch(/id-token|NPM_TOKEN|NODE_AUTH_TOKEN/u);
  });

  it("validates the canonical branch and every exact upstream run", () => {
    expect(step("Validate closeout input shape").run).toContain(
      'expected_ref="refs/heads/extended-stable/${release_year}.${release_month}.33"',
    );
    expect(step("Require tag at canonical branch tip").run).toContain(
      'if [[ "$release_sha" != "$branch_sha" ]]',
    );
    expect(step("Require tag at canonical branch tip").run).toContain(
      'if [[ "$release_sha" != "$WORKFLOW_SHA" ]]',
    );
    const identity = step("Validate closeout release identity");
    expect(identity.env).toMatchObject({
      NPM_WORKFLOW_REF: "${{ github.ref }}",
      RELEASE_NPM_DIST_TAG: "extended-stable",
    });
    expect(identity.run).toContain("validate-request");
    expect(step("Verify preflight run").run).toContain("verify-preflight-run");
    expect(step("Verify preflight run").run).toContain("/jobs?per_page=100");
    expect(step("Verify preflight run").run).toContain("/artifacts?per_page=100");
    for (const name of ["Verify plugin npm run", "Verify Full Release Validation run"]) {
      expect(step(name).run).toContain("verify-run");
    }
    expect(step("Verify core npm run").run).toContain("verify-core-run");
  });

  it("consumes the frozen plugin plan and uploads the exact compact artifact contract", () => {
    const setup = step("Setup Node environment");
    expect(setup.with?.["install-deps"]).toBe("false");
    const downloadPlan = step("Download frozen plugin plan");
    expect(downloadPlan.uses).toContain("actions/download-artifact@");
    expect(downloadPlan.with).toMatchObject({
      name: "plugin-npm-release-plan-${{ github.sha }}",
      "run-id": "${{ inputs.plugin_npm_run_id }}",
    });
    expect(readFileSync(workflowPath, "utf8")).not.toContain("plugin-npm-release-plan.ts");
    const verify = step("Verify final npm registry state");
    expect(verify.run).toContain("verify-registry");
    expect(verify.env?.PLUGIN_PLAN_FILE).toBe(
      "extended-stable-closeout/plugin-plan/plugin-npm-release-plan.json",
    );
    expect(verify.env?.SNAPSHOT_FILE).toBe("extended-stable-registry-snapshot.json");
    const upload = step("Upload compact registry snapshot");
    expect(upload.id).toBe("registry_snapshot");
    expect(upload.with).toMatchObject({
      name: "extended-stable-registry-snapshot-${{ inputs.tag }}",
      path: "extended-stable-registry-snapshot.json",
      "if-no-files-found": "error",
    });
    const summary = step("Summarize registry snapshot artifact");
    expect(summary.env?.ARTIFACT_NAME).toBe("extended-stable-registry-snapshot-${{ inputs.tag }}");
    expect(summary.env?.ARTIFACT_DIGEST).toBe(
      "${{ steps.registry_snapshot.outputs.artifact-digest }}",
    );
  });

  it("keeps extended-stable closeout npm-only", () => {
    const workflows = [
      readFileSync(".github/workflows/plugin-npm-release.yml", "utf8"),
      readFileSync(".github/workflows/openclaw-npm-release.yml", "utf8"),
      readFileSync(workflowPath, "utf8"),
    ];
    const executableSurface = workflows
      .flatMap((raw) => {
        const parsed = parse(raw) as Workflow;
        return Object.values(parsed.jobs ?? {}).flatMap((job) => [
          job.uses ?? "",
          ...(job.steps ?? []).flatMap((candidate) => [candidate.uses ?? "", candidate.run ?? ""]),
        ]);
      })
      .join("\n")
      .toLowerCase();
    for (const forbidden of [
      "openclaw-release-publish.yml",
      "plugin-clawhub-release.yml",
      "docker-release",
      "macos-release",
      "sparkle-release",
      "windows-release",
      "website-release",
      "android-release",
      "ios-release",
      "gh workflow run",
      "softprops/action-gh-release",
    ]) {
      expect(executableSurface).not.toContain(forbidden);
    }
  });
});
