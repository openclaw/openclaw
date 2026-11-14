import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sourceSha = "a".repeat(40);
const toolingSha = "b".repeat(40);

it.each(["ordinary", "historical", "recovery", "wrong producer", "unbound producer"])(
  "projects authenticated publication artifacts: %s",
  (scenario) => {
    const workflow = parse(readFileSync(".github/workflows/openclaw-release-publish.yml", "utf8"));
    const step = workflow.jobs.resolve_release_target.steps.find(
      (entry: { name: string }) => entry.name === "Validate full release validation manifest",
    );
    const marker = "node --input-type=module <<'NODE'\n";
    const offset = step.run.indexOf(marker);
    // Projection is downstream of strict authentication, never its replacement.
    expect(step.run.slice(0, offset)).toContain('node "$VALIDATOR_FILE" < "$RUN_JSON_FILE"');
    expect(step.run.slice(0, offset)).toContain('--consumer publisher --manifest "$manifest"');
    const script = step.run.slice(offset + marker.length).split("\nNODE")[0];
    const directory = tempDirs.make("release-publish-provenance-");
    symlinkSync(resolve("."), join(directory, ".release-validation-tooling"), "dir");
    const manifestDirectory = join(directory, "full-release-validation-manifest");
    mkdirSync(manifestDirectory);
    const artifact = {
      repository: "openclaw/openclaw",
      runId: 300,
      runAttempt: 1,
      workflowPath: ".github/workflows/plugin-npm-release.yml",
      workflowEvent: "workflow_dispatch",
      workflowHeadBranch: "release-ci/aaaaaaaaaaaa-100",
      workflowSha: scenario === "ordinary" ? toolingSha : sourceSha,
      artifactId: 500,
      artifactName: `plugin-npm-prepared-${sourceSha}-300-1`,
      artifactDigest: `sha256:${"c".repeat(64)}`,
      artifactSizeBytes: 100,
    };
    if (scenario === "wrong producer") {
      artifact.workflowSha = toolingSha;
    }
    const manifest = {
      targetSha: sourceSha,
      workflowSha: toolingSha,
      runId: "200",
      runAttempt: "1",
      publicationArtifacts: scenario === "historical" ? {} : { pluginNpm: artifact },
      ...(scenario === "recovery" || scenario === "wrong producer"
        ? {
            sourceAdmission: { candidateSha: sourceSha, runId: "200" },
            receiptRecovery: {
              schema: "openclaw.full-release-receipt-recovery/v1",
              candidateBinding: { request: { targetSha: sourceSha, toolingSha: sourceSha } },
              originalParent: { runId: "100" },
              children: { normalCi: { workflowRef: "release-ci/aaaaaaaaaaaa-100" } },
            },
          }
        : {}),
    };
    writeFileSync(
      join(manifestDirectory, "full-release-validation-manifest.json"),
      JSON.stringify(manifest),
    );
    const output = join(directory, "output");
    writeFileSync(output, "");
    const result = spawnSync(process.execPath, ["--input-type=module"], {
      cwd: directory,
      input: script,
      encoding: "utf8",
      env: {
        ...process.env,
        RUNNER_TEMP: directory,
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: "openclaw/openclaw",
        EXPECTED_SHA: sourceSha,
        FULL_RELEASE_VALIDATION_RUN_ID: "200",
        FULL_RELEASE_VALIDATION_RUN_ATTEMPT: "1",
        PLUGIN_PUBLISH_SCOPE: "all-publishable",
        PUBLISH_DOCKER_ONLY: "false",
      },
    });
    if (scenario === "wrong producer" || scenario === "unbound producer") {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Prepared npm artifact descriptor differs");
      expect(readFileSync(output, "utf8")).toBe("");
    } else {
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(output, "utf8")).toBe(
        scenario === "historical" ? "" : `plugin_npm_artifact=${JSON.stringify(artifact)}\n`,
      );
    }
  },
);

// The production owner test counts full authentications; this guards the Actions
// boundary that previously discarded its result and invoked a second process.
it("checks npm lineage in the full authentication process after selecting its producer", () => {
  const workflow = parse(readFileSync(".github/workflows/openclaw-release-publish.yml", "utf8"));
  const steps = workflow.jobs.resolve_release_target.steps;
  const download = steps.findIndex((entry: { id: string }) => entry.id === "preflight_artifact");
  const authenticate = steps.findIndex((entry: { id: string }) => entry.id === "full_manifest");
  const npm = steps.findIndex((entry: { id: string }) => entry.id === "manifest");
  expect(download).toBeLessThan(authenticate);
  expect(authenticate).toBeLessThan(npm);
  expect(steps[authenticate].env).toMatchObject({
    VERIFY_NPM_PREFLIGHT_LINEAGE:
      "${{ steps.preflight_artifact.outputs.workflow_path == '.github/workflows/full-release-validation.yml' || steps.preflight_artifact.outputs.workflow_path == '.github/workflows/full-release-artifacts.yml' }}",
    PREFLIGHT_WORKFLOW_SHA: "${{ steps.preflight_artifact.outputs.head_sha }}",
    PREFLIGHT_RUN_ID: "${{ steps.preflight_artifact.outputs.run_id }}",
    PREFLIGHT_RUN_ATTEMPT: "${{ steps.preflight_artifact.outputs.run_attempt }}",
  });
  expect(steps[npm].run).toContain(
    '"$PREFLIGHT_WORKFLOW_PATH" != ".github/workflows/full-release-validation.yml" && "$PREFLIGHT_WORKFLOW_PATH" != ".github/workflows/full-release-artifacts.yml"',
  );
});
