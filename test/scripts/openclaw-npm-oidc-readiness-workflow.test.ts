import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW_PATH = ".github/workflows/openclaw-npm-release.yml";
const UPLOAD_ARTIFACT_V7 = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";

type WorkflowInput = {
  default?: boolean | string;
  required?: boolean;
  type?: string;
};

type WorkflowStep = {
  env?: Record<string, string>;
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  environment?: string;
  env?: Record<string, string>;
  if?: string;
  permissions?: Record<string, string>;
  "runs-on"?: string;
  secrets?: Record<string, string>;
  steps?: WorkflowStep[];
  "timeout-minutes"?: number;
};

type Workflow = {
  jobs: Record<string, WorkflowJob>;
  on?: {
    workflow_dispatch?: {
      inputs?: Record<string, WorkflowInput>;
    };
  };
};

function workflow(): Workflow {
  return parse(readFileSync(WORKFLOW_PATH, "utf8")) as Workflow;
}

function job(parsed: Workflow, name: string): WorkflowJob {
  const found = parsed.jobs[name];
  if (!found) {
    throw new Error(`Missing workflow job: ${name}`);
  }
  return found;
}

function step(foundJob: WorkflowJob, name: string): WorkflowStep {
  const found = foundJob.steps?.find((candidate) => candidate.name === name);
  if (!found) {
    throw new Error(`Missing workflow step: ${name}`);
  }
  return found;
}

function expectRunToContain(foundStep: WorkflowStep, snippets: string[]): void {
  expect(foundStep.run).toBeDefined();
  for (const snippet of snippets) {
    expect(foundStep.run).toContain(snippet);
  }
}

describe("npm OIDC readiness workflow", () => {
  it("is an explicit exclusive no-publish mode with minimum permissions", () => {
    const parsed = workflow();
    const inputs = parsed.on?.workflow_dispatch?.inputs;
    expect(inputs?.oidc_readiness).toMatchObject({
      default: false,
      required: true,
      type: "boolean",
    });
    for (const name of [
      "oidc_preflight_run_id",
      "oidc_preflight_artifact_id",
      "oidc_preflight_artifact_digest",
      "oidc_target_sha",
    ]) {
      expect(inputs?.[name]).toMatchObject({ required: false, type: "string" });
    }

    expect(job(parsed, "preflight_openclaw_npm").if).toBe(
      "${{ inputs.preflight_only && !inputs.oidc_readiness }}",
    );
    expect(job(parsed, "validate_publish_request").if).toBe(
      "${{ !inputs.preflight_only && !inputs.oidc_readiness }}",
    );
    expect(job(parsed, "publish_openclaw_npm").if).toBe(
      "${{ !inputs.preflight_only && !inputs.oidc_readiness }}",
    );

    const oidc = job(parsed, "npm_oidc_readiness");
    expect(oidc).toMatchObject({
      if: "${{ inputs.oidc_readiness }}",
      environment: "npm-release",
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 20,
      permissions: {
        actions: "read",
        contents: "read",
        "id-token": "write",
      },
    });
    expect(oidc.secrets).toBeUndefined();
    expect(oidc.env).toBeUndefined();
    expect(oidc.steps?.some((candidate) => candidate.uses?.startsWith("actions/checkout@"))).toBe(
      false,
    );

    expectRunToContain(step(oidc, "Prepare isolated npm environment"), [
      'isolated_home="$work_dir/home"',
      'npm_cache="$work_dir/npm-cache"',
      'npm_userconfig="$work_dir/npmrc"',
      'echo "HOME=$isolated_home"',
      'echo "NPM_CONFIG_CACHE=$npm_cache"',
      'echo "NPM_CONFIG_USERCONFIG=$npm_userconfig"',
      '>> "$GITHUB_ENV"',
    ]);
    const validate = step(oidc, "Validate OIDC readiness inputs");
    expect(validate.env).toMatchObject({
      WORKFLOW_REF: "${{ fromJSON(toJSON(job)).workflow_ref }}",
      WORKFLOW_REPOSITORY: "${{ fromJSON(toJSON(job)).workflow_repository }}",
      WORKFLOW_SHA: "${{ fromJSON(toJSON(job)).workflow_sha }}",
    });
    expectRunToContain(validate, [
      '"$EVENT_NAME" != "workflow_dispatch"',
      'expected_workflow_ref="openclaw/openclaw/.github/workflows/openclaw-npm-release.yml@refs/heads/main"',
      '"$WORKFLOW_REPOSITORY" != "openclaw/openclaw"',
      '"$WORKFLOW_REF" != "$expected_workflow_ref"',
      '[[ "$RUN_ATTEMPT" != "1" ]]',
      '[[ ! "$WORKFLOW_SHA" =~ ^[0-9a-f]{40}$ ]]',
      '[[ "$PREFLIGHT_ONLY" != "true" ]]',
      '[[ "$NPM_DIST_TAG" != "beta" ]]',
      '[[ ! "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]',
      '[[ "$RELEASE_TAG" != "$TARGET_SHA" ]]',
      '[[ ! "$PREFLIGHT_RUN_ID" =~ ^[1-9][0-9]*$ ]]',
      '[[ ! "$ARTIFACT_ID" =~ ^[1-9][0-9]*$ ]]',
      '[[ ! "$ARTIFACT_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]',
      "Number.isSafeInteger(parsed)",
    ]);
  });

  it("accepts only the immutable attempt-1 exact-target root and AI preflight artifact", () => {
    const parsed = workflow();
    const oidc = job(parsed, "npm_oidc_readiness");
    const verify = step(oidc, "Download and verify exact-target npm preflight artifact");

    expect(verify.env).toEqual({
      ARTIFACT_DIGEST: "${{ inputs.oidc_preflight_artifact_digest }}",
      ARTIFACT_ID: "${{ inputs.oidc_preflight_artifact_id }}",
      GH_TOKEN: "${{ github.token }}",
      PREFLIGHT_RUN_ID: "${{ inputs.oidc_preflight_run_id }}",
      TARGET_SHA: "${{ inputs.oidc_target_sha }}",
    });
    expectRunToContain(verify, [
      '.name == "OpenClaw NPM Release"',
      '.path == ".github/workflows/openclaw-npm-release.yml"',
      '.event == "workflow_dispatch"',
      '.status == "completed"',
      '.conclusion == "success"',
      ".run_attempt == 1",
      ".head_sha == $target_sha",
      'expected_artifact_name="openclaw-npm-preflight-${TARGET_SHA}"',
      ".id == $artifact_id",
      ".name == $expected_name",
      ".expired == false",
      ".digest == $digest",
      ".workflow_run.id == $run_id",
      ".workflow_run.head_sha == $target_sha",
      'gh api "repos/${GITHUB_REPOSITORY}/actions/artifacts/${ARTIFACT_ID}/zip"',
      '"sha256:${artifact_zip_sha256}" != "$ARTIFACT_DIGEST"',
      "extract_unique_member preflight-manifest.json",
      "extract_unique_member dependency-evidence/dependency-evidence-manifest.json",
      "manifest.releaseSha === process.env.TARGET_SHA",
      'manifest.npmDistTag === "beta"',
      'manifest.packageName === "openclaw"',
      "manifest.dependencyTarballs.length === 1",
      'ai.packageName === "@openclaw/ai"',
      "new Set(entries).size === entries.length",
      'dependencyManifest.workflowRunAttempt === "1"',
      "dependencyManifest.reports.length === 4",
      "declaredReportEntries.size === expectedReportEntries.size",
      "entries.every((entry) => allowedEntries.has(entry))",
      "npm preflight artifact contains missing or undeclared ZIP members",
      "OIDC readiness AI checksum manifest does not match the declared tarball.",
      "OIDC readiness release SHA marker does not match the target.",
      "OIDC readiness root tarball digest mismatch.",
      "OIDC readiness AI tarball digest mismatch.",
      "tarball package identity does not match the preflight manifest",
    ]);

    const raw = readFileSync(WORKFLOW_PATH, "utf8");
    expect(raw).not.toContain("811ddd96180583bae00001f71971419182ae0520");
    expect(raw).not.toContain("9511fec6731a6ab27881ff9ad83a0304439363947fc16678df8cbe835aa2bffd");
  });

  it("uses npm 11.12.1 and requires OIDC acquisition in two independent dry-runs", () => {
    const parsed = workflow();
    const oidc = job(parsed, "npm_oidc_readiness");
    const install = step(oidc, "Install exact npm CLI");
    const exercise = step(oidc, "Exercise npm OIDC token acquisition without publishing");

    expectRunToContain(install, [
      "npm@11.12.1",
      'npm_version="$("$npm_cli" --version)"',
      '[[ "$npm_version" != "11.12.1" ]]',
      "unset NODE_AUTH_TOKEN NPM_TOKEN NPM_AUTH_TOKEN",
      "unset npm_config__auth npm_config__authToken npm_config_auth npm_config_authtoken",
    ]);
    expectRunToContain(exercise, [
      "unset NODE_AUTH_TOKEN NPM_TOKEN NPM_AUTH_TOKEN",
      "unset npm_config__auth npm_config__authToken npm_config_auth npm_config_authtoken",
      "unset npm_config_userconfig NPM_CONFIG__AUTH NPM_CONFIG__AUTHTOKEN",
      'marker_phrase="Successfully retrieved and set token"',
      'marker="npm verbose oidc ${marker_phrase}"',
      'marker_count="$(grep -Fxc "$marker" "$log_path" || true)"',
      '[[ "$marker_count" != "1" ]]',
      "index($0, phrase) && $0 != expected",
      "$0 ~ /^npm verbose oidc / && $0 != expected",
      "^npm (warn|error).*",
      "authentication warning or failure",
      'root_redacted_log_sha256="$(validate_oidc_log "Root" "$root_log" "$root_redacted_log")"',
      'ai_redacted_log_sha256="$(validate_oidc_log "AI" "$ai_log" "$ai_redacted_log")"',
      "npm OIDC dry-run persisted authentication material to userconfig.",
      'rm -f "$root_log" "$ai_log" "$root_redacted_log" "$ai_redacted_log"',
      'echo "root_redacted_log_sha256=$root_redacted_log_sha256"',
      'echo "ai_redacted_log_sha256=$ai_redacted_log_sha256"',
    ]);

    const publishLines =
      exercise.run
        ?.split("\n")
        .map((line) => line.trim())
        .filter((line) => line.includes('"$NPM_CLI" publish')) ?? [];
    expect(publishLines).toHaveLength(2);
    expect(publishLines[0]).toContain('"$ROOT_TGZ"');
    expect(publishLines[1]).toContain('"$AI_TGZ"');
    for (const line of publishLines) {
      expect(line).toContain("--tag beta");
      expect(line).toContain("--dry-run");
      expect(line).toContain("--ignore-scripts");
      expect(line).toContain("--provenance=false");
      expect(line).toContain("--loglevel=verbose");
    }
    expect(oidc.steps?.map((candidate) => candidate.run ?? "").join("\n")).not.toContain(
      "scripts/openclaw-npm-publish.sh",
    );
  });

  it("rejects marker text embedded in notice or package content", () => {
    const phrase = "Successfully retrieved and set token";
    const marker = `npm verbose oidc ${phrase}`;
    const exactMarkerCount = (log: string): number => {
      const result = spawnSync("grep", ["-Fxc", marker], {
        input: log,
        encoding: "utf8",
      });
      expect(result.error).toBeUndefined();
      expect([0, 1]).toContain(result.status);
      return Number.parseInt(result.stdout.trim(), 10);
    };

    const spoofed = [
      `npm notice filename: openclaw-${phrase}.tgz`,
      `npm notice ${phrase}`,
      `package/content/${phrase}`,
      "",
    ].join("\n");
    expect(exactMarkerCount(spoofed)).toBe(0);
    expect(exactMarkerCount(`${spoofed}${marker}\n`)).toBe(1);
    expect(exactMarkerCount(`${marker}\n${marker}\n`)).toBe(2);
  });

  it("uploads one immutable secret-free JSON evidence artifact", () => {
    const parsed = workflow();
    const oidc = job(parsed, "npm_oidc_readiness");
    const write = step(oidc, "Write npm OIDC readiness evidence");
    const uploads = oidc.steps?.filter((candidate) => candidate.uses === UPLOAD_ARTIFACT_V7) ?? [];

    expect(write.env).toMatchObject({
      AI_REDACTED_LOG_SHA256: "${{ steps.oidc.outputs.ai_redacted_log_sha256 }}",
      ROOT_REDACTED_LOG_SHA256: "${{ steps.oidc.outputs.root_redacted_log_sha256 }}",
      WORKFLOW_REF: "${{ fromJSON(toJSON(job)).workflow_ref }}",
      WORKFLOW_REPOSITORY: "${{ fromJSON(toJSON(job)).workflow_repository }}",
      WORKFLOW_SHA: "${{ fromJSON(toJSON(job)).workflow_sha }}",
    });
    expectRunToContain(write, [
      'schema: "openclaw.npm-oidc-readiness/v1"',
      'workflowPath: ".github/workflows/openclaw-npm-release.yml"',
      "workflowRepository: process.env.WORKFLOW_REPOSITORY",
      "workflowRef: process.env.WORKFLOW_REF",
      "workflowSha: process.env.WORKFLOW_SHA",
      "runId: positiveInteger",
      "runAttempt: positiveInteger",
      "evidence.producer.runAttempt !== 1",
      "targetSha: process.env.TARGET_SHA",
      "sourcePreflight:",
      "artifactId: positiveInteger",
      "artifactDigest: process.env.ARTIFACT_DIGEST",
      "artifactZipSha256: process.env.ARTIFACT_ZIP_SHA256",
      'npmVersion !== "11.12.1"',
      'proofScope: "oidc-token-acquisition-readiness-only"',
      "tokenAcquisitionReady: true",
      'registryTrustedPublisherAcceptance: "not-tested"',
      "publicationPerformed: false",
      'operation: "publish"',
      'distTag: "beta"',
      "dryRun: true",
      "ignoreScripts: true",
      "provenance: false",
      'loglevel: "verbose"',
      'const marker = "npm verbose oidc Successfully retrieved and set token"',
      "markerObserved:",
      "redactedLogSha256:",
      "!sha256Pattern.test(entry.redactedLogSha256)",
      'conclusion: "success"',
      "OIDC readiness must emit exactly one JSON evidence file.",
    ]);
    expect(write.run).not.toContain("TOKEN");
    expect(write.run).not.toContain("token:");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toEqual({
      name: "Upload npm OIDC readiness evidence",
      uses: UPLOAD_ARTIFACT_V7,
      with: {
        name: "npm-oidc-readiness-${{ github.run_id }}-${{ github.run_attempt }}",
        path: "${{ runner.temp }}/npm-oidc-readiness/evidence/npm-oidc-readiness.json",
        "if-no-files-found": "error",
        "retention-days": 14,
      },
    });
  });

  it("uses called-workflow identity for trusted tooling in direct and reusable contexts", () => {
    const parsed = workflow();
    const publish = job(parsed, "publish_openclaw_npm");
    const checkout = step(publish, "Checkout trusted delta verifier");
    const verify = step(publish, "Verify release delta evidence");

    expect(checkout.with).toMatchObject({
      repository: "${{ fromJSON(toJSON(job)).workflow_repository }}",
      ref: "${{ fromJSON(toJSON(job)).workflow_sha }}",
      path: ".release-delta-tooling",
      "persist-credentials": false,
    });
    expect(verify.run).not.toContain("--policy");
    const raw = readFileSync(WORKFLOW_PATH, "utf8");
    expect(raw).not.toContain("${{ github.workflow_sha }}");
    expect(raw).not.toContain("${{ github.workflow_ref }}");
  });
});
