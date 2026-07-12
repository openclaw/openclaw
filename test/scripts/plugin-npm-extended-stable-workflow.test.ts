import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflowPath = ".github/workflows/plugin-npm-release.yml";

type Step = { env?: Record<string, string>; name?: string; run?: string };
type Job = {
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
    expect(workflow().on?.workflow_dispatch?.inputs?.npm_dist_tag).toEqual({
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
    expect(publish.run).toContain(
      'git fetch --no-tags origin "+refs/heads/${WORKFLOW_BRANCH}:refs/remotes/origin/${WORKFLOW_BRANCH}"',
    );
    expect(publish.run).toContain('"$current_tip" != "$SOURCE_SHA"');
    expect(publish.run).toContain("Refusing stale extended-stable plugin publish");
    const verify = parsed.jobs?.verify_plugins_npm;
    expect(verify?.needs).toEqual(["preview_plugins_npm", "publish_plugins_npm"]);
    expect(verify?.if).toContain("always()");
    expect(verify?.strategy?.matrix?.plugin).toContain("all_matrix");
    const readback = step(verify, "Verify complete plugin registry readback");
    expect(readback.run).toContain('npm view "${PACKAGE_NAME}@${PACKAGE_VERSION}" version');
    expect(readback.run).toContain('npm view "${PACKAGE_NAME}@extended-stable" version');
  });
});
