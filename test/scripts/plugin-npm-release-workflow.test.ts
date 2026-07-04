// Plugin npm release workflow tests protect extended-stable publication ownership.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflowPath = ".github/workflows/plugin-npm-release.yml";

type Step = { env?: Record<string, string>; if?: string; name?: string; run?: string };
type Job = { permissions?: Record<string, string>; steps?: Step[] };
type Workflow = {
  on?: { workflow_dispatch?: { inputs?: { publish_scope?: { options?: string[] } } } };
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

describe("plugin npm extended-stable publication", () => {
  it("exposes the fixed policy mode and publishes candidates with OIDC only", () => {
    const parsed = workflow();
    expect(parsed.on?.workflow_dispatch?.inputs?.publish_scope?.options).toContain(
      "extended-stable",
    );
    const publish = parsed.jobs?.publish_plugins_npm;
    const sourceBinding = step(
      parsed.jobs?.preview_plugins_npm,
      "Bind extended-stable source to provenance SHA",
    );
    expect(sourceBinding.run).toContain('"${SOURCE_SHA}" != "${PROVENANCE_SHA}"');
    const releaseLine = step(
      parsed.jobs?.preview_plugins_npm,
      "Validate extended-stable release line",
    );
    expect(releaseLine.run).toContain("extended-stable/([0-9]{4})");
    expect(releaseLine.run).toContain("patch 33 or above");
    expect(releaseLine.run).toContain('"${BASH_REMATCH[1]}" != "${branch_year}"');
    expect(step(parsed.jobs?.preview_plugins_npm, "Resolve plugin release plan").run).toContain(
      "matrix_selector='.all'",
    );
    expect(publish?.permissions?.["id-token"]).toBe("write");
    const packageCheck = step(publish, "Check npm package version");
    expect(packageCheck.run).toContain("Could not authoritatively query");
    expect(packageCheck.run).toContain('if [[ -z "${CANDIDATE_TAG}" ]]');
    expect(packageCheck.env?.CANDIDATE_TAG).toBe("${{ matrix.plugin.candidateTag }}");
    const candidate = step(publish, "Publish extended-stable candidate");
    expect(candidate.if).toContain("already_published != 'true'");
    expect(candidate.env).toEqual({ OPENCLAW_NPM_PUBLISH_AUTH_MODE: "trusted-publisher" });
    expect(candidate.run).toContain("--candidate-tag");
    expect(candidate.run).not.toContain("NPM_TOKEN");
    const reconcile = step(publish, "Verify extended-stable candidate tag");
    expect(reconcile.env?.ALREADY_PUBLISHED).toContain("already_published");
    expect(reconcile.run).toContain("is immutable and already published");
    expect(reconcile.run).toContain("will not republish or retag it");
    expect(reconcile.run).toContain("Could not authoritatively read npm dist-tags");
    const provenance = step(publish, "Verify extended-stable npm provenance");
    expect(provenance.run).toContain("dist.attestations.provenance.predicateType");
    expect(provenance.run).toContain("npm audit signatures");
  });

  it("emits one closed aggregate without mutating shared dist-tags", () => {
    const raw = readFileSync(workflowPath, "utf8");
    const parsed = workflow();
    const aggregate = parsed.jobs?.aggregate_extended_stable_publication;
    expect(
      step(aggregate, "Upload aggregate publication result").run ??
        raw.includes(
          "extended-stable-plugin-publication-${{ github.run_id }}-${{ github.run_attempt }}",
        ),
    ).toBeTruthy();
    expect(raw).toContain("extended-stable-plugin-publication.json");
    expect(raw).not.toContain("npm dist-tag add");
    expect(raw).not.toContain("npm dist-tag rm");
  });
});
