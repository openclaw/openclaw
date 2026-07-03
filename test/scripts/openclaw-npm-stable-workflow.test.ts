import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflowPath = ".github/workflows/openclaw-npm-release.yml";

type Step = { env?: Record<string, string>; id?: string; if?: string; name?: string; run?: string };
type Job = { environment?: string; steps?: Step[] };
type Workflow = {
  on?: { workflow_dispatch?: { inputs?: { npm_dist_tag?: { options?: string[] } } } };
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

describe("minimal npm stable workflow", () => {
  it("adds stable without adding policy or verifier contracts", () => {
    const raw = readFileSync(workflowPath, "utf8");
    const parsed = workflow();
    expect(parsed.on?.workflow_dispatch?.inputs?.npm_dist_tag?.options).toEqual([
      "alpha",
      "beta",
      "latest",
      "stable",
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

  it("reuses the v1 preflight tarball and guards all three stable gates", () => {
    const parsed = workflow();
    const raw = readFileSync(workflowPath, "utf8");
    expect(raw).toContain("version: 1");
    expect(raw).toContain("openclaw-npm-preflight-${{ inputs.tag }}");
    expect(raw.match(/openclaw-npm-stable-release\.mjs validate-request/g)).toHaveLength(3);
    expect(step(parsed.jobs?.preflight_openclaw_npm, "Validate npm release request").run).toContain(
      "openclaw-npm-stable-release.mjs validate-request",
    );
    expect(
      step(parsed.jobs?.validate_publish_request, "Validate npm release request").run,
    ).toContain("openclaw-npm-stable-release.mjs validate-request");
    expect(step(parsed.jobs?.publish_openclaw_npm, "Recheck npm release request").run).toContain(
      "openclaw-npm-stable-release.mjs validate-request",
    );
    expect(
      parsed.jobs?.validate_publish_request?.steps?.map((candidate) => candidate.name),
    ).not.toContain("Setup Node environment");
  });

  it("authenticates exact stable run and Full Validation identities", () => {
    const raw = readFileSync(workflowPath, "utf8");
    expect(raw).toContain("--json workflowName,headBranch,headSha,event,conclusion,url");
    expect(raw).toContain("--json workflowName,headBranch,headSha,event,status,conclusion,url");
    expect(raw.match(/openclaw-npm-stable-release\.mjs verify-run/g)).toHaveLength(2);
    expect(raw).toContain("openclaw-npm-stable-release.mjs verify-manifest");
  });

  it("captures selector fail closed, publishes stable, retries readback, and summarizes repair", () => {
    const parsed = workflow();
    const publish = parsed.jobs?.publish_openclaw_npm;
    const capture = step(publish, "Capture previous stable selector");
    const readback = step(publish, "Verify stable registry readback");
    const summary = step(publish, "Summarize stable npm publication");
    expect(capture.run).toContain("openclaw-npm-stable-release.mjs capture-selector");
    expect(step(publish, "Publish").run).toContain("openclaw-npm-publish.sh");
    expect(readback.run).toContain("openclaw-npm-stable-release.mjs verify-readback");
    expect(summary.if).toContain("always()");
    expect(summary.run).toContain("openclaw-npm-stable-release.mjs repair-command");
    expect(publish?.environment).toBe("npm-release");
  });

  it("publishes only the tarball path verified from the preflight manifest", () => {
    const publish = workflow().jobs?.publish_openclaw_npm;
    const provenance = step(publish, "Verify prepared tarball provenance");
    const publishStep = step(publish, "Publish");
    expect(provenance.run).toContain(
      'ARTIFACT_TARBALL_PATH="preflight-tarball/$ARTIFACT_TARBALL_NAME"',
    );
    expect(provenance.run).toContain('echo "tarball_path=$ARTIFACT_TARBALL_PATH"');
    expect(publishStep.env?.PUBLISH_TARBALL_PATH).toBe(
      "${{ steps.preflight_provenance.outputs.tarball_path }}",
    );
    expect(publish?.steps?.map((candidate) => candidate.name)).not.toContain(
      "Resolve publish tarball",
    );
    expect(readFileSync(workflowPath, "utf8")).not.toContain(
      "find preflight-tarball -type f -name '*.tgz'",
    );
  });
});
