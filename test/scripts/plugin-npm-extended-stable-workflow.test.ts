import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflowPath = ".github/workflows/plugin-npm-release.yml";

type Step = {
  env?: Record<string, string>;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
};
type Job = {
  environment?: string;
  if?: string;
  needs?: string[] | string;
  steps?: Step[];
  strategy?: { matrix?: { plugin?: string } };
};
type Workflow = {
  on?: {
    workflow_dispatch?: {
      inputs?: {
        npm_dist_tag?: { default?: string; options?: string[]; type?: string };
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

describe("plugin npm extended-stable workflow", () => {
  it("exposes only the default behavior and closed extended-stable override", () => {
    expect(readFileSync(workflowPath, "utf8")).toContain(
      "Plugin NPM Release [{0}] {1}', inputs.npm_dist_tag, inputs.ref",
    );
    const input = workflow().on?.workflow_dispatch?.inputs?.npm_dist_tag;
    expect(input).toEqual({
      description: "Optional npm dist-tag override",
      required: true,
      default: "default",
      type: "choice",
      options: ["default", "extended-stable"],
    });
  });

  it("uses one override for check, plan, preview, pack, and publish", () => {
    const parsed = workflow();
    const raw = readFileSync(workflowPath, "utf8");
    expect(raw.match(/--npm-dist-tag "\$\{NPM_DIST_TAG\}"/gu)).toHaveLength(2);
    const expectedOverride =
      "${{ inputs.npm_dist_tag == 'extended-stable' && inputs.npm_dist_tag || '' }}";
    for (const name of ["Preview publish command", "Preview npm pack contents", "Publish"]) {
      expect(
        step(
          parsed.jobs?.[name === "Publish" ? "publish_plugins_npm" : "preview_plugin_pack"],
          name,
        ).env,
      ).toMatchObject({ OPENCLAW_PLUGIN_NPM_PUBLISH_TAG: expectedOverride });
    }
  });

  it("trusts only the canonical monthly branch at the exact checked-out SHA", () => {
    const trusted = step(
      workflow().jobs?.preview_plugins_npm,
      "Validate ref is on a trusted publish branch",
    );
    expect(trusted.run).toContain("extended-stable/${release_year}.${release_month}.33");
    expect(trusted.run).toContain("exact 40-character source SHA");
    expect(trusted.run).toContain(
      '[[ "${WORKFLOW_REF}" == "refs/heads/${extended_stable_branch}" ]]',
    );
    expect(trusted.run).toContain(
      '[[ "$(git rev-parse HEAD)" == "$(git rev-parse "refs/remotes/origin/${extended_stable_branch}")" ]]',
    );
  });

  it("publishes extended-stable with OIDC only and verifies every package tag", () => {
    const parsed = workflow();
    const publish = step(parsed.jobs?.publish_plugins_npm, "Publish");
    const tokenExpression =
      "${{ inputs.npm_dist_tag != 'extended-stable' && secrets.NPM_TOKEN || '' }}";
    expect(publish.env).toMatchObject({
      NODE_AUTH_TOKEN: tokenExpression,
      NPM_TOKEN: tokenExpression,
      OPENCLAW_NPM_PUBLISH_AUTH_MODE: "trusted-publisher",
    });
    expect(parsed.jobs?.reconcile_plugins_npm).toBeUndefined();
    expect(readFileSync(workflowPath, "utf8")).not.toContain(
      'npm dist-tag add "${PACKAGE_NAME}@${PACKAGE_VERSION}" extended-stable',
    );

    const verify = parsed.jobs?.verify_plugins_npm;
    expect(verify?.needs).toEqual(["preview_plugins_npm", "publish_plugins_npm"]);
    expect(verify?.if).toContain("always()");
    expect(verify?.if).toContain("has_candidates == 'false'");
    expect(verify?.strategy?.matrix?.plugin).toContain("all_matrix");
    const readback = step(verify, "Verify complete plugin registry readback");
    expect(readback.run).toContain('npm view "${PACKAGE_NAME}@${PACKAGE_VERSION}" version');
    expect(readback.run).toContain('npm view "${PACKAGE_NAME}@extended-stable" version');
    expect(readback.run).toContain("OIDC-only source workflow does not mutate tags");
  });

  it("uploads the source-bound plugin plan for read-only closeout", () => {
    const upload = step(
      workflow().jobs?.preview_plugins_npm,
      "Upload frozen extended-stable plugin plan",
    );
    expect(upload.if).toContain("inputs.npm_dist_tag == 'extended-stable'");
    expect(upload.uses).toContain("actions/upload-artifact@");
    expect(upload.with).toMatchObject({
      name: "plugin-npm-release-plan-${{ steps.ref.outputs.sha }}",
      path: ".local/plugin-npm-release-plan.json",
      "if-no-files-found": "error",
    });
  });
});
