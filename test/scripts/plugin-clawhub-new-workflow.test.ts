import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW_PATH = ".github/workflows/plugin-clawhub-new.yml";
const PACKAGE_PUBLISH_WORKFLOW =
  "openclaw/clawhub/.github/workflows/package-publish.yml@d8096dfc039e86ab942ddf9ef117d04849fd84c1";
const UPLOAD_ARTIFACT_V7 = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";

type WorkflowStep = {
  env?: Record<string, string>;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  environment?: string;
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  secrets?: Record<string, string>;
  steps?: WorkflowStep[];
  strategy?: {
    "fail-fast"?: boolean;
    "max-parallel"?: number;
    matrix?: Record<string, string>;
  };
  uses?: string;
  with?: Record<string, unknown>;
};

type Workflow = {
  jobs: Record<string, WorkflowJob>;
};

function workflow(): Workflow {
  return parse(readFileSync(WORKFLOW_PATH, "utf8")) as Workflow;
}

function step(job: WorkflowJob, name: string): WorkflowStep {
  const found = job.steps?.find((candidate) => candidate.name === name);
  if (!found) {
    throw new Error(`Missing workflow step: ${name}`);
  }
  return found;
}

describe("Plugin ClawHub New workflow", () => {
  it("creates the normal three-artifact proof set for dry-run bootstrap packages", () => {
    const jobs = workflow().jobs;
    const pack = jobs.pack_bootstrap_plugins_dry_run;
    const inspect = jobs.inspect_bootstrap_plugins_dry_run;
    const identity = step(pack, "Verify dry-run bootstrap package identity");
    const packPackage = step(pack, "Pack dry-run ClawHub package artifact");
    const upload = step(pack, "Upload dry-run ClawHub package artifact");

    expect(pack.if).toBe(
      "github.event_name == 'workflow_dispatch' && inputs.dry_run == true && needs.resolve_bootstrap_plan.outputs.has_bootstrap_candidates == 'true'",
    );
    expect(pack.needs).toBe("resolve_bootstrap_plan");
    expect(pack.environment).toBeUndefined();
    expect(pack.strategy).toMatchObject({
      "fail-fast": false,
      "max-parallel": 8,
      matrix: {
        plugin: "${{ fromJson(needs.resolve_bootstrap_plan.outputs.matrix) }}",
      },
    });

    expect(identity.env).toEqual({
      TARGET_SHA: "${{ needs.resolve_bootstrap_plan.outputs.ref_revision }}",
      PACKAGE_NAME: "${{ matrix.plugin.packageName }}",
      PACKAGE_VERSION: "${{ matrix.plugin.version }}",
      PACKAGE_DIR: "${{ matrix.plugin.packageDir }}",
      PACKAGE_ARTIFACT_NAME: "${{ matrix.plugin.artifactName }}",
    });
    expect(identity.run).toContain('"$(git rev-parse HEAD)"');
    expect(identity.run).toContain("manifest.name !== packageName");
    expect(identity.run).toContain("manifest.version !== packageVersion");
    expect(identity.run).toContain("manifest.openclaw?.release?.publishToClawHub !== true");
    expect(identity.run).toContain(
      "const expectedArtifactName = `clawhub-package-${safeName}-${packageVersion}`",
    );

    expect(packPackage.env).toMatchObject({
      SOURCE_COMMIT: "${{ needs.resolve_bootstrap_plan.outputs.ref_revision }}",
      SOURCE_REF: "${{ inputs.ref || github.ref }}",
      PACKAGE_TAG: "${{ matrix.plugin.publishTag }}",
      PACKAGE_DIR: "${{ matrix.plugin.packageDir }}",
    });
    expect(packPackage.run).toBe('bash scripts/plugin-clawhub-publish.sh --pack "${PACKAGE_DIR}"');
    expect(upload).toEqual({
      name: "Upload dry-run ClawHub package artifact",
      uses: UPLOAD_ARTIFACT_V7,
      with: {
        name: "${{ matrix.plugin.artifactName }}",
        path: "${{ runner.temp }}/clawhub-package-artifact/*.tgz",
        "if-no-files-found": "error",
        "retention-days": 7,
      },
    });

    expect(inspect.if).toContain("inputs.dry_run == true");
    expect(inspect.if).toContain("needs.pack_bootstrap_plugins_dry_run.result == 'success'");
    expect(inspect.needs).toEqual(["resolve_bootstrap_plan", "pack_bootstrap_plugins_dry_run"]);
    expect(inspect.uses).toBe(PACKAGE_PUBLISH_WORKFLOW);
    expect(inspect.environment).toBeUndefined();
    expect(inspect.secrets).toBeUndefined();
    expect(inspect.permissions).toEqual({
      actions: "read",
      contents: "read",
      "id-token": "write",
    });
    expect(inspect.with).toMatchObject({
      package_artifact_name: "${{ matrix.plugin.artifactName }}",
      dry_run: true,
      version: "${{ matrix.plugin.version }}",
      tags: "${{ matrix.plugin.publishTag }}",
      source_repo: "${{ github.repository }}",
      source_commit: "${{ needs.resolve_bootstrap_plan.outputs.ref_revision }}",
      source_ref: "${{ inputs.ref || github.ref }}",
      source_path: "${{ matrix.plugin.packageDir }}",
      inspector_artifact_name: "${{ matrix.plugin.artifactName }}-inspector",
      publish_json_artifact_name: "${{ matrix.plugin.artifactName }}-publish-json",
    });
  });

  it("skips every token or environment mutation job during dry runs", () => {
    const jobs = workflow().jobs;
    const approval = jobs.validate_release_publish_approval;
    const cli = jobs.validate_bootstrap_trusted_publisher_cli;
    const publish = jobs.publish_bootstrap_plugins;
    const verify = jobs.verify_bootstrap_clawhub_package;

    expect(approval.if).toContain("inputs.dry_run != true");
    expect(cli.if).toContain("inputs.dry_run != true");
    expect(publish.if).toContain("inputs.dry_run != true");
    expect(verify.if).toContain("inputs.dry_run != true");

    expect(publish.environment).toBe("clawhub-plugin-bootstrap");
    expect(step(publish, "Write ClawHub token config").if).toBe("inputs.dry_run != true");
    expect(step(publish, "Publish ClawHub bootstrap package").run).toContain(
      "bash scripts/plugin-clawhub-publish.sh --publish",
    );
    expect(step(publish, "Configure trusted publisher for normal OIDC releases").if).toBe(
      "inputs.dry_run != true",
    );
  });
});
