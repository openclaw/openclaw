import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflowPath = ".github/workflows/openclaw-npm-release.yml";

type Step = { env?: Record<string, string>; id?: string; if?: string; name?: string; run?: string };
type Job = { if?: string; permissions?: Record<string, string>; steps?: Step[] };
type Workflow = {
  on?: {
    workflow_dispatch?: {
      inputs?: {
        bypass_extended_stable_guard?: { default?: boolean; type?: string };
        npm_dist_tag?: { options?: string[] };
      };
    };
  };
  jobs?: Record<string, Job>;
};

function workflow(): Workflow {
  return parse(readFileSync(workflowPath, "utf8")) as Workflow;
}

function step(job: Job | undefined, name: string): Step {
  const found = job?.steps?.find((candidate) => candidate.name === name);
  if (!found) {
    throw new Error(`Missing workflow step: ${name}`);
  }
  return found;
}

describe("minimal npm extended-stable workflow", () => {
  it("adds extended-stable without adding policy or verifier contracts", () => {
    const raw = readFileSync(workflowPath, "utf8");
    const parsed = workflow();
    expect(parsed.on?.workflow_dispatch?.inputs?.npm_dist_tag?.options).toEqual([
      "extended-stable",
    ]);
    for (const forbidden of [
      "release-policy",
      "policyMode",
      "release-operation-verifier",
      "external_contract_revision",
      "stable-lines.json",
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("reuses the v1 preflight tarball and removes every publish job", () => {
    const parsed = workflow();
    const raw = readFileSync(workflowPath, "utf8");
    expect(raw).toContain("version: 1");
    expect(raw).toContain("openclaw-npm-preflight-${{ inputs.tag }}");
    expect(raw.match(/openclaw-npm-extended-stable-release\.mjs validate-request/g)).toHaveLength(
      1,
    );
    expect(step(parsed.jobs?.preflight_openclaw_npm, "Validate npm release request").run).toContain(
      "openclaw-npm-extended-stable-release.mjs validate-request",
    );
    expect(
      step(parsed.jobs?.preflight_openclaw_npm, "Validate npm release request").env?.PREFLIGHT_ONLY,
    ).toBe("${{ inputs.preflight_only }}");
    expect(parsed.jobs?.validate_publish_request).toBeUndefined();
    expect(parsed.jobs?.publish_openclaw_npm).toBeUndefined();
    expect(raw).not.toContain("id-token: write");
  });

  it("requires explicit SHA-only rehearsal inputs and rejects publish-mode dispatch", () => {
    const parsed = workflow();
    const input = parsed.on?.workflow_dispatch?.inputs?.bypass_extended_stable_guard;
    expect(input).toMatchObject({ default: false, type: "boolean" });

    const policyStep = step(parsed.jobs?.preflight_openclaw_npm, "Validate npm release request");
    expect(policyStep.env?.BYPASS_EXTENDED_STABLE_GUARD).toBe(
      "${{ inputs.bypass_extended_stable_guard }}",
    );
    const refGuard = step(parsed.jobs?.preflight_openclaw_npm, "Validate release ref input format");
    expect(refGuard.run).toContain("requires a full 40-character commit SHA");
    expect(refGuard.run).toContain("dev/throwaway-2026.0.33-v6.8");
    expect(refGuard.run).toContain("requires preflight_only=true");
    expect(refGuard.env?.WORKFLOW_SHA).toBe("${{ github.sha }}");
    expect(refGuard.run).toContain('"${RELEASE_REF,,}" != "${WORKFLOW_SHA,,}"');
    expect(refGuard.run).toContain("requires tag to equal the selected branch head SHA");
    expect(parsed.jobs?.reject_non_preflight?.if).toBe("${{ !inputs.preflight_only }}");
    expect(step(parsed.jobs?.reject_non_preflight, "Reject publish-mode dispatch").run).toContain(
      "publish jobs are absent",
    );
  });

  it("accepts the exact SHA preflight target and exercises every publishable plugin package", () => {
    const parsed = workflow();
    const preflight = parsed.jobs?.preflight_openclaw_npm;
    const metadata = step(preflight, "Validate release metadata");
    expect(metadata.run).toContain('RELEASE_BRANCH_REF="${RELEASE_SHA}"');
    expect(metadata.run).not.toContain("Validation-only SHA mode only supports");

    const plugins = step(preflight, "Exercise all extended-stable plugin npm packages");
    expect(
      step(preflight, "Verify release contents").env
        ?.OPENCLAW_RELEASE_CHECK_LOCAL_PACKAGE_TARBALL_DIR,
    ).toBeUndefined();
    expect(readFileSync(workflowPath, "utf8")).not.toContain("ai_runtime_tarballs");
    expect(plugins.if).toBe("${{ inputs.npm_dist_tag == 'extended-stable' }}");
    expect(plugins.env).toMatchObject({
      OPENCLAW_PLUGIN_NPM_PUBLISH_TAG: "extended-stable",
    });
    expect(plugins.run).toContain("--selection-mode all-publishable");
    expect(plugins.run).not.toContain("--npm-dist-tag");
    expect(plugins.run).toContain("scripts/check-plugin-npm-runtime-builds.mjs");
    expect(plugins.run).toContain("scripts/plugin-npm-publish.sh --pack");
    expect(plugins.run).toContain("OPENCLAW_PLUGIN_NPM_PACK_OUTPUT_DIR");
    expect(plugins.run).not.toContain("--publish");
    expect(step(preflight, "Upload extended-stable plugin npm packages")).toBeDefined();
  });
});
