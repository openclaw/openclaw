import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const INSTALL_SMOKE = ".github/workflows/install-smoke.yml";
const INSTALL_SMOKE_REUSABLE = ".github/workflows/install-smoke-reusable.yml";
const RELEASE_CHECKS = ".github/workflows/openclaw-release-checks.yml";
const readOnlyPermissions = { actions: "read", contents: "read", packages: "read" };
const optInBoolean = { default: false, type: "boolean" };
const reference = (scope: string, field: string) => `\${{ ${scope}.${field} }}`;
function references(scope: string, fields: string, uppercase = false) {
  return Object.fromEntries(
    fields
      .split(" ")
      .map((field) => [uppercase ? field.toUpperCase() : field, reference(scope, field)]),
  );
}
const imageFields =
  "archive_sha256 artifact_digest artifact_id artifact_name artifact_run_attempt artifact_run_id";
const imageOutputs = {
  ...references("steps.image_artifact.outputs", "archive_sha256 artifact_name"),
  artifact_digest: reference("steps.image_artifact_upload.outputs", "artifact-digest"),
  artifact_id: reference("steps.image_artifact_upload.outputs", "artifact-id"),
  artifact_run_attempt: reference("steps.image_artifact.outputs", "run_attempt"),
  artifact_run_id: reference("steps.image_artifact.outputs", "run_id"),
};
const candidateScope = "needs.installer_smoke_candidate_payload.outputs";

type WorkflowStep = {
  env?: Record<string, string>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  "working-directory"?: string;
};

type WorkflowJob = {
  env?: Record<string, string>;
  if?: string;
  needs?: string | string[];
  outputs?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  "continue-on-error"?: boolean;
  "runs-on"?: string;
  steps?: WorkflowStep[];
  "timeout-minutes"?: number | string;
  uses?: string;
  with?: Record<string, unknown>;
};

type Workflow = {
  jobs: Record<string, WorkflowJob>;
  on?: {
    schedule?: unknown;
    workflow_call?: { inputs?: Record<string, Record<string, unknown>> };
    workflow_dispatch?: { inputs?: Record<string, Record<string, unknown>> };
  };
  permissions?: Record<string, unknown>;
};

function readWorkflow(workflowPath: string): Workflow {
  return parse(readFileSync(workflowPath, "utf8")) as Workflow;
}

function job(name: string, source: Workflow = workflow): WorkflowJob {
  const found = source.jobs[name];
  expect(found, name).toBeDefined();
  return found!;
}

function step(workflowJob: WorkflowJob, name: string): WorkflowStep {
  const found = workflowJob.steps?.find((candidate) => candidate.name === name);
  expect(found, name).toBeDefined();
  return found!;
}

function assertText(actual: string | undefined, message?: string) {
  const fragments = (negated: boolean) => (expected: string) => {
    const assertion = expect(actual, message);
    const matcher = negated ? assertion.not : assertion;
    for (const fragment of expected.split("\n")) {
      matcher.toContain(fragment);
    }
  };
  return { contains: fragments(false), excludes: fragments(true) };
}

function git(directory: string, ...args: string[]) {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();
}

function runShell(script: string, env: NodeJS.ProcessEnv, cwd?: string) {
  return spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, ...env },
  });
}

const workflow = readWorkflow(INSTALL_SMOKE_REUSABLE);

it("keeps schedule/manual orchestration read-only and delegates to the reusable core", () => {
  const scheduledWorkflow = readWorkflow(INSTALL_SMOKE);
  expect(scheduledWorkflow.on?.schedule).toBeDefined();
  expect(scheduledWorkflow.on?.workflow_dispatch?.inputs).toMatchObject({
    run_bun_global_install_smoke: optInBoolean,
    update_baseline_version: { default: "latest", type: "string" },
  });
  expect(scheduledWorkflow.on?.workflow_call).toBeUndefined();
  expect(scheduledWorkflow.permissions).toEqual(readOnlyPermissions);

  const delegated = job("install_smoke", scheduledWorkflow);
  expect(delegated.permissions).toEqual(readOnlyPermissions);
  expect(delegated.uses).toBe(`./${INSTALL_SMOKE_REUSABLE}`);
  expect(delegated.with).toMatchObject({
    allow_unreleased_changelog: true,
    ref: "${{ github.sha }}",
    run_bun_global_install_smoke:
      "${{ github.event_name == 'schedule' || inputs.run_bun_global_install_smoke }}",
    update_baseline_version: "${{ inputs.update_baseline_version || 'latest' }}",
  });
  // The Bun-only lane is Full Release Validation only: never nightly or manual Install Smoke.
  expect(delegated.with).not.toHaveProperty("run_bun_only_runtime_smoke");
  expect(readFileSync(INSTALL_SMOKE, "utf8")).not.toContain("packages: write");
});

it("makes the reusable core artifact-only and rejects registry transport", () => {
  expect(workflow.on?.schedule).toBeUndefined();
  expect(workflow.on?.workflow_dispatch).toBeUndefined();
  expect(workflow.on?.workflow_call?.inputs).toMatchObject({
    allow_unreleased_changelog: optInBoolean,
    allow_frozen_target_scenario_omissions: optInBoolean,
  });
  expect(workflow.on?.workflow_call?.inputs?.root_image_transport).toBeUndefined();
  expect(workflow.permissions).toEqual(readOnlyPermissions);

  const preflight = job("preflight");
  expect(preflight.outputs?.workflow_repository).toBeUndefined();
  expect(preflight.outputs?.workflow_sha).toBeUndefined();
  const workflowIdentity = step(preflight, "Assert trusted workflow identity");
  expect(workflowIdentity.env).toEqual({
    EXPECTED_WORKFLOW_REPOSITORY: "${{ github.repository }}",
    JOB_CONTEXT: "${{ toJSON(job) }}",
  });
  assertText(workflowIdentity.run)
    .contains(`job.workflow_repository must exactly match github.repository
job.workflow_sha must be a full lowercase commit SHA`);
  assertText(workflowIdentity.run).excludes(`EXPECTED_WORKFLOW_SHA`);
  expect(step(preflight, "Materialize selected-source contract resolver").with).toMatchObject({
    repository: "${{ steps.workflow.outputs.workflow_repository }}",
    ref: "${{ steps.workflow.outputs.workflow_sha }}",
    path: ".release-harness",
    "persist-credentials": false,
    "sparse-checkout": "scripts/resolve-fs-safe-native-contract.mjs",
  });

  const identityOutput = path.join(tempDirs.make("install-smoke-workflow-identity-"), "output");
  const runIdentity = (script: string, repository: string, sha: string) =>
    runShell(script, {
      EXPECTED_WORKFLOW_REPOSITORY: "openclaw/openclaw",
      GITHUB_OUTPUT: identityOutput,
      GITHUB_WORKFLOW_SHA: "a".repeat(40),
      JOB_CONTEXT: JSON.stringify({ workflow_repository: repository, workflow_sha: sha }),
    });
  const identityResult = runIdentity(workflowIdentity.run!, "openclaw/openclaw", "b".repeat(40));
  expect(identityResult.status, identityResult.stderr).toBe(0);
  expect(readFileSync(identityOutput, "utf8")).toBe(
    `workflow_repository=openclaw/openclaw\nworkflow_sha=${"b".repeat(40)}\n`,
  );
  const workflowText = JSON.stringify(workflow);
  assertText(workflowText).excludes(`\${{ github.workflow_sha }}
fromJSON(toJSON(job)).workflow_
needs.preflight.outputs.workflow_`);

  const fastJob = job("install-smoke-fast");
  const warningRelay = step(fastJob, "Checkout trusted build warning relay");
  expect(fastJob.needs).toContain("preflight");
  expect(warningRelay.with).toMatchObject({
    repository: "openclaw/openclaw",
    ref: "${{ github.sha }}",
    path: ".artifacts/build-warning-harness",
    "fetch-depth": 1,
    "persist-credentials": false,
    "sparse-checkout-cone-mode": false,
    "sparse-checkout": "scripts/relay-build-limit-warnings.mts\nscripts/lib/check-limits.mts\n",
  });
  const warningBuild = step(fastJob, "Build root Dockerfile smoke image");
  expect(warningBuild.run).toContain(
    "node .artifacts/build-warning-harness/scripts/relay-build-limit-warnings.mts",
  );
  expect(
    fastJob.steps!.indexOf(step(fastJob, "Resolve exact trusted workflow identity")),
  ).toBeLessThan(fastJob.steps!.indexOf(warningBuild));
  const trustedJobs: string[] = [];
  for (const [jobName, workflowJob] of Object.entries(workflow.jobs)) {
    const trustedCheckouts =
      workflowJob.steps?.filter((candidate) => candidate.name?.startsWith("Checkout trusted")) ??
      [];
    if (trustedCheckouts.length === 0) {
      continue;
    }
    trustedJobs.push(jobName);
    const resolver = step(workflowJob, "Resolve exact trusted workflow identity");
    expect(resolver.env, jobName).toMatchObject({
      EXPECTED_WORKFLOW_REPOSITORY: "${{ github.repository }}",
      JOB_CONTEXT: "${{ toJSON(job) }}",
    });
    const harnessPath =
      jobName === "install-smoke-fast" ? ".artifacts/build-warning-harness" : ".release-harness";
    assertText(resolver.run, jobName).contains(`job.workflow_sha must be a full lowercase commit SHA
\`repository=\${repository}\\nsha=\${job.workflow_sha}\\n\``);
    assertText(resolver.run, jobName).excludes(`execFileSync`);
    const checkoutIndex = workflowJob.steps!.indexOf(trustedCheckouts[0]!);
    const resolverIndex = workflowJob.steps!.indexOf(resolver);
    expect(resolverIndex, jobName).toBeLessThan(checkoutIndex);
    const restore = step(workflowJob, "Restore exact trusted workflow revision");
    expect(workflowJob.steps!.indexOf(restore), jobName).toBe(checkoutIndex + 1);
    expect(restore.env, jobName).toMatchObject({
      HARNESS_PATH: harnessPath,
      WORKFLOW_REPOSITORY: "${{ steps.workflow.outputs.repository }}",
      WORKFLOW_SHA: "${{ steps.workflow.outputs.sha }}",
    });
    for (const checkout of trustedCheckouts) {
      expect(checkout.with, jobName).toMatchObject({
        repository: "openclaw/openclaw",
        ref: "${{ github.sha }}",
        path: harnessPath,
        "fetch-depth": 1,
        "persist-credentials": false,
      });
    }
  }

  expect(trustedJobs.toSorted()).toEqual(
    `bun_global_install_smoke bun_only_runtime_smoke install-smoke-fast
installer_smoke_candidate_payload installer_smoke_nonroot installer_smoke_nonroot_image
installer_smoke_update installer_smoke_update_image root_dockerfile_image root_dockerfile_smokes`
      .split(/\s+/)
      .toSorted(),
  );

  const candidateResolver = step(
    job("installer_smoke_candidate_payload"),
    "Resolve exact trusted workflow identity",
  );
  const runResolver = (workflowRepository: string, workflowSha: string) =>
    runIdentity(candidateResolver.run!, workflowRepository, workflowSha);
  const malformedSha = runResolver("openclaw/openclaw", "not-a-sha");
  expect(malformedSha.status).not.toBe(0);
  expect(malformedSha.stderr).toContain("job.workflow_sha must be a full lowercase commit SHA");
  const wrongRepository = runResolver("attacker/openclaw", "b".repeat(40));
  expect(wrongRepository.status).not.toBe(0);
  expect(wrongRepository.stderr).toContain(
    "job.workflow_repository must exactly match github.repository",
  );
  // The per-job resolver must work before any harness checkout exists.
  const validIdentity = runResolver("openclaw/openclaw", "c".repeat(40));
  expect(validIdentity.status, validIdentity.stderr).toBe(0);
  expect(readFileSync(identityOutput, "utf8")).toContain(`sha=${"c".repeat(40)}\n`);
  const manifest = step(preflight, "Build install-smoke CI manifest");
  expect(manifest.env).toEqual({
    OPENCLAW_CI_WORKFLOW_BUN_GLOBAL_INSTALL_SMOKE:
      "${{ inputs.run_bun_global_install_smoke || 'false' }}",
  });
  const manifestRun = manifest.run;
  if (!manifestRun) {
    throw new Error("Build install-smoke CI manifest must have a run script");
  }
  assertText(manifestRun)
    .contains(`dockerfile_image="openclaw-dockerfile-smoke-local:\${target_sha}"
run_bun_global_install_smoke="$workflow_bun_global_install_smoke"
refs/heads/extended-stable/*:refs/remotes/origin/extended-stable/*`);
  assertText(manifestRun).excludes(`event_name
workflow_call`);
  expect(
    manifestRun.indexOf("git fetch --quiet --unshallow --no-tags --filter=blob:none origin"),
  ).toBeLessThan(manifestRun.indexOf("resolve-fs-safe-native-contract.mjs"));

  const text = readFileSync(INSTALL_SMOKE_REUSABLE, "utf8");
  assertText(text).excludes(`packages: write
docker/login-action@
--push`);
  expect(workflow.jobs.push_root_dockerfile_image).toBeUndefined();
});

it("builds one local target image and uploads provenance-bound bytes", () => {
  const producer = job("root_dockerfile_image");
  expect(producer.permissions).toEqual({ contents: "read", packages: "read" });
  expect(producer.outputs).toMatchObject({
    ...imageOutputs,
    image_ref: "${{ steps.image.outputs.image_ref }}",
  });
  expect(producer.outputs?.image_exists).toBeUndefined();
  expect(producer.steps?.find((candidate) => candidate.name === "Checkout CLI")).toBeUndefined();
  const sourceArchive = step(producer, "Download exact candidate source archive");
  assertText(sourceArchive.run)
    .contains(`"https://codeload.github.com/\${TARGET_REPOSITORY}/tar.gz/\${TARGET_SHA}"
test -f "$candidate_dir/Dockerfile"`);
  expect(step(producer, "Checkout trusted release harness").if).toBeUndefined();

  const localBuild = step(producer, "Build local root Dockerfile smoke image");
  expect(localBuild.if).toBeUndefined();
  assertText(localBuild.run).contains(`--load
-t "$IMAGE_REF"
-f "$CANDIDATE_DIR/Dockerfile"`);
  assertText(localBuild.run).excludes(`--push`);

  const pack = step(producer, "Pack root Dockerfile image artifact");
  expect(pack.if).toBeUndefined();
  expect(pack.env).toMatchObject({
    IMAGE_REF: "${{ needs.preflight.outputs.dockerfile_image }}",
    TARGET_SHA: "${{ needs.preflight.outputs.target_sha }}",
    WORKFLOW_SHA: "${{ steps.workflow.outputs.sha }}",
  });
  assertText(pack.run)
    .contains(`artifact_name="install-smoke-root-image-\${TARGET_SHA:0:12}-\${GITHUB_RUN_ID}-\${GITHUB_RUN_ATTEMPT}"
pack "$artifact_dir" install-smoke-root "$TARGET_SHA" "$WORKFLOW_SHA" "$IMAGE_REF"`);

  const upload = step(producer, "Upload root Dockerfile image artifact");
  expect(upload.if).toBeUndefined();
  expect(upload.uses).toBe("actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9");
  expect(upload.with).toMatchObject({
    "compression-level": 0,
    "if-no-files-found": "error",
    name: "${{ steps.image_artifact.outputs.artifact_name }}",
    path: "${{ steps.image_artifact.outputs.artifact_path }}",
  });

  const ready = job("root_dockerfile_image_ready");
  expect(ready.needs).toEqual(["preflight", "root_dockerfile_image"]);
  const verify = step(ready, "Verify root Dockerfile image preparation");
  expect(verify.env).toEqual({
    PREPARE_RESULT: "${{ needs.root_dockerfile_image.result }}",
  });
  assertText(verify.run).contains(`if [[ "$PREPARE_RESULT" != "success" ]]`);
  assertText(verify.run).excludes(`PUSH_RESULT`);
});

it("verifies and loads the immutable artifact in every consumer", () => {
  const consumer = job("root_dockerfile_smokes");
  expect(consumer.needs).toContain("root_dockerfile_image_ready");
  expect(consumer.env?.OPENCLAW_DOCKER_E2E_REQUIRE_LOCAL_IMAGE).toBe("1");
  expect(step(consumer, "Checkout trusted release harness").if).toBeUndefined();
  for (const name of ["Log in to GHCR", "Pull root Dockerfile smoke image"]) {
    expect(consumer.steps?.find((candidate) => candidate.name === name)).toBeUndefined();
  }

  const binding = step(consumer, "Validate root Dockerfile image artifact binding");
  expect(binding.if).toBeUndefined();
  expect(binding.env).toMatchObject({
    ...references("needs.root_dockerfile_image.outputs", imageFields, true),
    GH_TOKEN: "${{ github.token }}",
    TARGET_SHA: "${{ needs.preflight.outputs.target_sha }}",
  });
  assertText(binding.run)
    .contains(`expected_artifact_name="install-smoke-root-image-\${TARGET_SHA:0:12}-\${ARTIFACT_RUN_ID}-\${ARTIFACT_RUN_ATTEMPT}"
[[ "$ARCHIVE_SHA256" =~ ^[a-f0-9]{64}$ ]]
bash .release-harness/scripts/docker/shared-image-artifact.sh
verify-upload "Root image"
"$ARTIFACT_RUN_ID" "$ARTIFACT_RUN_ATTEMPT"`);
  assertText(binding.run).excludes(`gh api
artifact_json=
attempt_json=
<<<`);

  const download = step(consumer, "Download root Dockerfile image artifact");
  expect(download.if).toBeUndefined();
  expect(download.with).toMatchObject({
    "artifact-ids": "${{ needs.root_dockerfile_image.outputs.artifact_id }}",
    "github-token": "${{ github.token }}",
    path: "${{ runner.temp }}/install-smoke-root-image",
    "run-id": "${{ needs.root_dockerfile_image.outputs.artifact_run_id }}",
  });

  const load = step(consumer, "Verify and load root Dockerfile image artifact");
  expect(load.if).toBeUndefined();
  assertText(load.run).contains(`load "\${RUNNER_TEMP}/install-smoke-root-image" install-smoke-root
"$TARGET_SHA" "$WORKFLOW_SHA" "$IMAGE_REF"`);

  const requireLocal = step(consumer, "Require local root Dockerfile image");
  expect(requireLocal.if).toBeUndefined();
  expect(requireLocal.run).toBe('docker image inspect "$IMAGE_REF" >/dev/null');

  const selectedCheckout = step(
    consumer,
    "Checkout selected source for gateway network provenance",
  );
  expect(step(consumer, "Prepare trusted selected-source Git owner").uses).toBe(
    "./.release-harness/.github/actions/git-owner",
  );
  expect(selectedCheckout.env).toMatchObject({
    CHECKOUT_KIND: "preflight",
    CHECKOUT_REPO: "openclaw/openclaw",
    CHECKOUT_REF: "${{ needs.preflight.outputs.target_sha }}",
    CHECKOUT_FALLBACK_REF: "${{ needs.preflight.outputs.target_sha }}",
    CHECKOUT_TOKEN: "",
    SELECTED_SOURCE_DIR: "${{ github.workspace }}/.release-source",
    WORKFLOW_SHA: "${{ steps.workflow.outputs.sha }}",
  });
  const gatewayNetwork = step(consumer, "Run Docker gateway network e2e");
  expect(gatewayNetwork.env).toMatchObject({
    OPENCLAW_DOCKER_E2E_REPO_ROOT: "${{ github.workspace }}/.release-source",
    OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS:
      "${{ inputs.allow_frozen_target_scenario_omissions && '1' || '0' }}",
    OPENCLAW_SELECTED_SHA: "${{ needs.preflight.outputs.target_sha }}",
    OPENCLAW_TOOLING_SHA: "${{ steps.workflow.outputs.sha }}",
  });

  const text = readFileSync(INSTALL_SMOKE_REUSABLE, "utf8");
  expect(text.match(/verify-upload "Root image"/g)).toHaveLength(1);
  expect(text).not.toContain("gh api");
});

it.each([
  { source: "selected", allowOmissions: "0" },
  { source: "tooling", allowOmissions: "1" },
  { source: "missing", allowOmissions: "1" },
])(
  "checks selected network source provenance before Docker: $source, omissions=$allowOmissions",
  ({ source, allowOmissions }) => {
    const workspace = tempDirs.make("install-smoke-source-binding-");
    const selected = path.join(workspace, ".release-source");
    const tooling = process.cwd();
    const origin = path.join(workspace, "source-origin");
    mkdirSync(origin);
    git(origin, "init", "--quiet");
    git(
      origin,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "selected source",
    );
    const selectedSha = git(origin, "rev-parse", "HEAD");
    const toolingSha = git(tooling, "rev-parse", "HEAD");
    symlinkSync(tooling, path.join(workspace, ".release-harness"), "dir");
    const bin = path.join(workspace, "bin");
    mkdirSync(bin);
    const dockerCalls = path.join(workspace, "docker-calls");
    writeFileSync(
      path.join(bin, "docker"),
      '#!/bin/sh\nprintf "%s\n" "$*" >>"$DOCKER_CALLS"\nexit 47\n',
      { mode: 0o755 },
    );
    const consumer = job("root_dockerfile_smokes");
    const checkout = step(consumer, "Checkout selected source for gateway network provenance");
    const checkoutEnv = Object.fromEntries(
      Object.entries(checkout.env ?? {}).map(([key, value]) => [
        key,
        value
          .replace("${{ github.workspace }}", workspace)
          .replace("${{ needs.preflight.outputs.target_sha }}", selectedSha)
          .replace("${{ steps.workflow.outputs.sha }}", toolingSha),
      ]),
    );
    const fetched = runShell(
      checkout.run!,
      {
        ...checkoutEnv,
        CI_GIT_OWNER: path.join(tooling, ".github/actions/git-owner/owner.py"),
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.${pathToFileURL(origin).href}.insteadOf`,
        GIT_CONFIG_VALUE_0: "https://github.com/openclaw/openclaw.git",
      },
      workspace,
    );
    expect(fetched.status, fetched.stdout + fetched.stderr).toBe(0);
    expect(git(selected, "rev-parse", "HEAD")).toBe(selectedSha);
    expect(git(selected, "config", "--local", "--list")).not.toMatch(/extraheader|AUTHORIZATION/i);
    const network = step(consumer, "Run Docker gateway network e2e");
    const configuredRoot = network.env?.OPENCLAW_DOCKER_E2E_REPO_ROOT?.replace(
      "${{ github.workspace }}",
      workspace,
    );
    const repoRoot =
      source === "selected"
        ? configuredRoot
        : source === "tooling"
          ? tooling
          : path.join(workspace, "absent");
    const result = runShell(
      network.run!,
      {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        DOCKER_CALLS: dockerCalls,
        OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: allowOmissions,
        OPENCLAW_SELECTED_SHA: selectedSha,
        OPENCLAW_TOOLING_SHA: toolingSha,
        OPENCLAW_GATEWAY_NETWORK_E2E_SKIP_BUILD: "1",
        OPENCLAW_DOCKER_E2E_REQUIRE_LOCAL_IMAGE: "1",
        OPENCLAW_DOCKER_E2E_REPO_ROOT: repoRoot ?? "",
      },
      workspace,
    );
    if (source === "selected") {
      expect(result.stderr).not.toContain("selected source checkout does not match");
      expect(existsSync(dockerCalls), result.stderr).toBe(true);
      expect(readFileSync(dockerCalls, "utf8")).toContain("image inspect");
    } else {
      expect(
        result.status,
        JSON.stringify({
          stderr: result.stderr,
          dockerCalls: existsSync(dockerCalls) ? readFileSync(dockerCalls, "utf8") : null,
        }),
      ).toBe(2);
      expect(result.stderr).toContain(
        source === "tooling"
          ? "selected source checkout does not match OPENCLAW_SELECTED_SHA"
          : "frozen source: unable to read selected source",
      );
      expect(existsSync(dockerCalls)).toBe(false);
    }
  },
);

it("forwards frozen-target omission authority from the release coordinator", () => {
  const releaseWorkflow = readWorkflow(RELEASE_CHECKS);
  expect(job("install_smoke_release_checks", releaseWorkflow).with).toMatchObject({
    allow_frozen_target_scenario_omissions: "${{ inputs.allow_frozen_target_scenario_omissions }}",
  });
});

it("binds independent installer producer-consumer pairs to immutable artifact tuples", () => {
  for (const group of ["update", "nonroot"]) {
    const imageLabel = group === "update" ? "installer smoke" : "installer non-root";
    const label = group === "update" ? "installer update" : "installer non-root";
    const kind = `install-smoke-${group}`;
    const prefix = `${kind}-image`;
    const producerName = `installer_smoke_${group}_image`;
    const producerScope = `needs.${producerName}.outputs`;
    const consumerName = `installer_smoke_${group}`;
    const producer = job(producerName);
    expect(producer.needs, producerName).toEqual(["preflight"]);
    expect(producer["timeout-minutes"], producerName).toBe(45);
    expect(producer.outputs, producerName).toEqual({
      ...imageOutputs,
      ...references("steps.image_artifact.outputs", "target_sha workflow_sha"),
    });
    expect(step(producer, `Build ${imageLabel} image`).run, producerName).toContain("--load");

    const pack = step(producer, `Pack ${imageLabel} image artifact`);
    assertText(pack.run, producerName)
      .contains(`artifact_name="${prefix}-\${TARGET_SHA}-\${GITHUB_RUN_ID}-\${GITHUB_RUN_ATTEMPT}"
pack "$artifact_dir" ${kind} "$TARGET_SHA" "$WORKFLOW_SHA" "$IMAGE_REF"
echo "archive_sha256=$archive_sha256"
echo "run_attempt=$GITHUB_RUN_ATTEMPT"
echo "run_id=$GITHUB_RUN_ID"
echo "target_sha=$TARGET_SHA"
echo "workflow_sha=$WORKFLOW_SHA"`);
    expect(step(producer, `Upload ${imageLabel} image artifact`).with, producerName).toMatchObject({
      "compression-level": 0,
      "if-no-files-found": "error",
      name: "${{ steps.image_artifact.outputs.artifact_name }}",
    });

    const consumer = job(consumerName);
    expect(consumer["timeout-minutes"], consumerName).toBe(group === "update" ? 120 : 60);

    const binding = step(consumer, `Validate ${label} image artifact binding`);
    expect(binding.env, consumerName).toMatchObject({
      ...references(producerScope, imageFields, true),
      ARTIFACT_TARGET_SHA: reference(producerScope, "target_sha"),
      ARTIFACT_WORKFLOW_SHA: reference(producerScope, "workflow_sha"),
      TARGET_SHA: "${{ needs.preflight.outputs.target_sha }}",
      WORKFLOW_SHA: "${{ steps.workflow.outputs.sha }}",
    });
    assertText(binding.run, consumerName).contains(`[[ "$ARTIFACT_ID" =~ ^[1-9][0-9]*$ ]]
[[ "$ARTIFACT_DIGEST" =~ ^[a-f0-9]{64}$ ]]
[[ "$ARCHIVE_SHA256" =~ ^[a-f0-9]{64}$ ]]
[[ "$ARTIFACT_TARGET_SHA" == "$TARGET_SHA" ]]
[[ "$ARTIFACT_WORKFLOW_SHA" == "$WORKFLOW_SHA" ]]
expected_artifact_name="${prefix}-\${TARGET_SHA}-\${ARTIFACT_RUN_ID}-\${ARTIFACT_RUN_ATTEMPT}"
verify-upload`);

    const download = step(consumer, `Download ${label} image artifact`);
    expect(download.with, consumerName).toMatchObject({
      "artifact-ids": reference(producerScope, "artifact_id"),
      "github-token": "${{ github.token }}",
      "run-id": reference(producerScope, "artifact_run_id"),
    });
    expect(download.with?.name, consumerName).toBeUndefined();

    const load = step(consumer, `Verify and load ${label} image artifact`);
    expect(load.env, consumerName).toMatchObject({
      OPENCLAW_SHARED_IMAGE_ARCHIVE_SHA256: reference(producerScope, "archive_sha256"),
      OPENCLAW_SHARED_IMAGE_RUN_ATTEMPT: reference(producerScope, "artifact_run_attempt"),
      OPENCLAW_SHARED_IMAGE_RUN_ID: reference(producerScope, "artifact_run_id"),
      ...references(producerScope, "target_sha workflow_sha", true),
    });
    expect(load.run, consumerName).toContain(`load "\${RUNNER_TEMP}/${prefix}" ${kind}`);

    expect(
      consumer.steps?.some((candidate) =>
        candidate.uses?.includes("./.github/actions/setup-node-env"),
      ),
    ).toBe(false);
    expect(step(consumer, `Run ${label} docker tests`).env).toMatchObject({
      OPENCLAW_INSTALL_SMOKE_FROZEN_PAYLOAD_DIR:
        "${{ runner.temp }}/install-smoke-candidate-payload",
      OPENCLAW_INSTALL_SMOKE_NODE_VERSION: "${{ env.NODE_VERSION }}",
      OPENCLAW_INSTALL_SMOKE_GROUP: group,
    });
  }

  const bunConsumer = job("bun_global_install_smoke");
  expect(bunConsumer.needs).toEqual(["preflight", "installer_smoke_candidate_payload"]);
  const bunBinding = step(bunConsumer, "Validate candidate payload artifact binding");
  expect(bunBinding.env).toMatchObject({
    ...references(
      candidateScope,
      "artifact_digest artifact_id artifact_run_attempt artifact_run_id",
      true,
    ),
    ARTIFACT_HARNESS_SHA: reference(candidateScope, "harness_sha"),
    ARTIFACT_TARGET_SHA: reference(candidateScope, "target_sha"),
    HARNESS_SHA: "${{ steps.workflow.outputs.sha }}",
    TARGET_SHA: "${{ needs.preflight.outputs.target_sha }}",
  });
  assertText(bunBinding.run).contains(`[[ "$ARTIFACT_HARNESS_SHA" == "$HARNESS_SHA" ]]
verify-upload`);
  expect(step(bunConsumer, "Download candidate payload artifact").with).toMatchObject({
    "artifact-ids": reference(candidateScope, "artifact_id"),
    "run-id": reference(candidateScope, "artifact_run_id"),
  });
  expect(step(bunConsumer, "Setup trusted release harness for Bun smoke")).toMatchObject({
    uses: "./.release-harness/.github/actions/setup-release-harness",
    with: { "node-version": "24.22.1" },
  });
  const bunVerify = step(bunConsumer, "Verify candidate payload contents");
  expect(bunVerify.env).toMatchObject({
    ...references(candidateScope, "manifest_sha256 package_version source_archive_sha256", true),
    PRODUCER_RUN_ATTEMPT: reference(candidateScope, "artifact_run_attempt"),
    PRODUCER_RUN_ID: reference(candidateScope, "artifact_run_id"),
  });
  assertText(bunVerify.run).contains(`install-smoke-candidate-payload.mts verify
--run-id "$PRODUCER_RUN_ID"
--run-attempt "$PRODUCER_RUN_ATTEMPT"`);
  expect(step(bunConsumer, "Install Bun for global smoke").run).toBe("npm install -g bun@1.4.4");
  expect(step(bunConsumer, "Run Bun global install candidate-payload smoke")).toMatchObject({
    "working-directory": ".release-harness",
    env: {
      OPENCLAW_BUN_GLOBAL_SMOKE_HOST_BUILD: "0",
      OPENCLAW_BUN_GLOBAL_SMOKE_PACKAGE_TGZ:
        "${{ runner.temp }}/install-smoke-candidate-payload/candidate.tgz",
    },
    run: "bash scripts/e2e/bun-global-install-smoke.sh",
  });
  assertText(JSON.stringify(bunConsumer)).excludes(`root_dockerfile_image
OPENCLAW_BUN_GLOBAL_SMOKE_DIST_IMAGE
./.release-harness/.github/actions/setup-node-env`);

  expect(workflow.on?.workflow_call?.inputs?.run_bun_only_runtime_smoke).toMatchObject(
    optInBoolean,
  );
  const bunOnlyConsumer = job("bun_only_runtime_smoke");
  expect(bunOnlyConsumer.needs).toEqual(["preflight", "installer_smoke_candidate_payload"]);
  expect(bunOnlyConsumer.if).toBe(
    "needs.preflight.outputs.run_full_install_smoke == 'true' && inputs.run_bun_only_runtime_smoke && !inputs.allow_frozen_target_scenario_omissions",
  );
  expect(bunOnlyConsumer["continue-on-error"]).toBe(true);
  expect(bunOnlyConsumer["runs-on"]).toBe(bunConsumer["runs-on"]);
  assertText(bunOnlyConsumer["runs-on"]).contains(`inputs.runner_group
ubuntu-24.04`);
  expect(bunOnlyConsumer["timeout-minutes"]).toBe(20);
  const bunOnlyNode = step(bunOnlyConsumer, "Setup Node for payload verification");
  expect(bunOnlyNode).toMatchObject({
    uses: "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
    with: { "node-version": "${{ env.NODE_VERSION }}", "package-manager-cache": false },
  });
  expect(step(bunOnlyConsumer, "Validate candidate payload artifact binding")).toBe(bunBinding);
  const bunOnlyDownload = step(bunOnlyConsumer, "Download candidate payload artifact");
  expect(bunOnlyDownload).toBe(step(bunConsumer, "Download candidate payload artifact"));
  expect(bunOnlyDownload.with).toMatchObject({
    path: "${{ runner.temp }}/install-smoke-candidate-payload",
    "github-token": "${{ github.token }}",
  });
  expect(step(bunOnlyConsumer, "Verify candidate payload contents")).toBe(bunVerify);
  const bunOnlySetup = step(bunOnlyConsumer, "Setup pinned Bun runtime");
  expect(bunOnlySetup.uses).toBe("./.release-harness/.github/actions/setup-test-bun");
  const bunOnlyRun = step(bunOnlyConsumer, "Run Bun-only runtime smoke");
  expect(bunOnlyRun).toMatchObject({
    "working-directory": ".release-harness",
    env: {
      OPENCLAW_BUN_ONLY_SMOKE_PACKAGE_TGZ:
        "${{ runner.temp }}/install-smoke-candidate-payload/candidate.tgz",
      OPENCLAW_BUN_ONLY_SMOKE_ARTIFACT_DIR: "${{ runner.temp }}/bun-only-runtime-smoke",
      OPENCLAW_BUN_ONLY_SMOKE_HIDE_SYSTEM_NODE: "1",
    },
    run: "bash scripts/e2e/bun-only-runtime-smoke.sh",
  });
  const bunOnlyUpload = step(bunOnlyConsumer, "Upload Bun-only runtime smoke artifacts");
  expect(bunOnlyUpload).toMatchObject({
    if: "always()",
    uses: "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9",
    with: {
      name: "bun-only-runtime-smoke-${{ github.run_attempt }}",
      path: ["md", "json", "jsonl", "log"]
        .map((extension) => `\${{ runner.temp }}/bun-only-runtime-smoke/*.${extension}\n`)
        .join(""),
      "retention-days": 14,
      "if-no-files-found": "ignore",
    },
  });
  expect(bunOnlyConsumer.steps).toEqual([
    bunOnlyNode,
    step(bunOnlyConsumer, "Resolve exact trusted workflow identity"),
    step(bunOnlyConsumer, "Checkout trusted release harness"),
    step(bunOnlyConsumer, "Restore exact trusted workflow revision"),
    bunBinding,
    bunOnlyDownload,
    bunVerify,
    bunOnlySetup,
    bunOnlyRun,
    bunOnlyUpload,
  ]);
  assertText(JSON.stringify(bunOnlyConsumer)).excludes(`setup-node-env
setup-release-harness
blacksmith
npm install -g bun
pnpm install`);
});

it("packages candidate code only in an isolated image and verifies the sealed payload", () => {
  const producer = job("installer_smoke_candidate_payload");
  expect(producer.needs).toEqual(["preflight"]);
  expect(producer["timeout-minutes"]).toBe(75);
  expect(producer.outputs).toMatchObject({
    artifact_digest: reference("steps.payload_upload.outputs", "artifact-digest"),
    artifact_id: reference("steps.payload_upload.outputs", "artifact-id"),
    ...references(
      "steps.payload.outputs",
      "harness_repository harness_sha manifest_sha256 package_version repository source_archive_sha256 target_sha",
    ),
  });
  expect(step(producer, "Require exact trusted installer harness").run).toContain(
    '[[ "$(git -C .release-harness rev-parse HEAD)" == "$EXPECTED_SHA" ]]',
  );
  const download = step(producer, "Download exact candidate source archive");
  expect(download.run).toContain(
    '"https://codeload.github.com/${TARGET_REPOSITORY}/tar.gz/${TARGET_SHA}"',
  );
  const packageStep = step(producer, "Package candidate only inside pinned harness");
  assertText(packageStep.run).contains(`--user node
--cap-drop ALL
pnpm install --frozen-lockfile`);
  expect(packageStep.run).not.toContain("github.token");
  const seal = step(producer, "Seal candidate payload in clean pinned harness");
  assertText(seal.run).contains(`--network none
install -d -m 0750 "$payload_dir"
--user "$(id -u):$(id -g)"`);
  expect(seal.run).not.toContain('chmod 0777 "$payload_dir"');
  assertText(seal.run).contains(`install-smoke-candidate-payload.mts seal
--harness-sha`);
  for (const consumerName of ["installer_smoke_update", "installer_smoke_nonroot"]) {
    const consumer = job(consumerName);
    expect(consumer.steps?.some(({ name }) => name === "Checkout candidate CLI")).toBe(false);
    const binding = step(consumer, "Validate candidate payload artifact binding");
    assertText(binding.run).contains(`verify-upload "Candidate payload"
expected_artifact_name="install-smoke-candidate-payload-\${TARGET_SHA}-\${ARTIFACT_RUN_ID}-\${ARTIFACT_RUN_ATTEMPT}"`);
    const verify = step(consumer, "Verify candidate payload contents");
    expect(verify.env).toMatchObject({
      ...references(candidateScope, "manifest_sha256 package_version source_archive_sha256", true),
      PRODUCER_RUN_ATTEMPT: reference(candidateScope, "artifact_run_attempt"),
      PRODUCER_RUN_ID: reference(candidateScope, "artifact_run_id"),
    });
    assertText(verify.run)
      .contains(`--run-id "$PRODUCER_RUN_ID"\n--run-attempt "$PRODUCER_RUN_ATTEMPT"\n--manifest-sha256
--source-archive-sha256`);
    expect(verify.run).not.toContain("$GITHUB_RUN_");
  }
});
it("drains every independent producer and consumer without sibling failure suppression", () => {
  const aggregate = job("installer_smoke");
  for (const group of ["update", "nonroot"]) {
    expect(job(`installer_smoke_${group}`).needs).toEqual([
      "preflight",
      "installer_smoke_candidate_payload",
      `installer_smoke_${group}_image`,
    ]);
  }

  expect(aggregate.if).toContain("always()");
  expect(aggregate.needs).toEqual(
    `preflight root_dockerfile_image root_dockerfile_image_ready installer_smoke_candidate_payload
installer_smoke_update_image installer_smoke_update installer_smoke_nonroot_image installer_smoke_nonroot`.split(
      /\s+/,
    ),
  );
  expect(aggregate["timeout-minutes"]).toBe(5);
  const verify = step(aggregate, "Verify installer smoke groups");
  const results = {
    CANDIDATE_PAYLOAD_RESULT: "${{ needs.installer_smoke_candidate_payload.result }}",
    NONROOT_CONSUMER_RESULT: "${{ needs.installer_smoke_nonroot.result }}",
    NONROOT_PRODUCER_RESULT: "${{ needs.installer_smoke_nonroot_image.result }}",
    ROOT_IMAGE_READY_RESULT: "${{ needs.root_dockerfile_image_ready.result }}",
    ROOT_IMAGE_RESULT: "${{ needs.root_dockerfile_image.result }}",
    UPDATE_CONSUMER_RESULT: "${{ needs.installer_smoke_update.result }}",
    UPDATE_PRODUCER_RESULT: "${{ needs.installer_smoke_update_image.result }}",
  };
  expect(verify.env).toEqual(results);
  for (const result of Object.keys(results)) {
    expect(verify.run).toContain(`"$${result}"`);
  }
});

it("selects the read-only reusable core from release checks", () => {
  const release = readWorkflow(RELEASE_CHECKS);
  const caller = job("install_smoke_release_checks", release);
  expect(caller.uses).toBe(`./${INSTALL_SMOKE_REUSABLE}`);
  expect(caller.permissions).toEqual(readOnlyPermissions);
  expect(caller.with).toMatchObject({
    allow_unreleased_changelog:
      "${{ needs.resolve_target.outputs.allow_unreleased_changelog == 'true' }}",
    ref: "${{ needs.resolve_target.outputs.revision }}",
    run_bun_global_install_smoke: true,
    run_bun_only_runtime_smoke: true,
  });
});

it("passes package changelog intent only to the candidate packager", () => {
  const packageCandidate = step(
    job("installer_smoke_candidate_payload"),
    "Package candidate only inside pinned harness",
  );
  expect(packageCandidate.env).toMatchObject({
    ALLOW_UNRELEASED_CHANGELOG: "${{ inputs.allow_unreleased_changelog }}",
  });
  expect(packageCandidate.run).toContain("--output-name candidate.tgz");
  expect(packageCandidate.run).not.toContain("--pack-json");
  assertText(packageCandidate.run).contains(`scripts/package-openclaw-for-docker.mts
grep -Fq -- '--allow-unreleased-changelog' scripts/package-openclaw-for-docker.mts`);
  expect(packageCandidate.run).not.toContain("[[ -f scripts/package-openclaw-for-docker.mts ]]");
  expect(packageCandidate.run).toContain("package_args+=(--allow-unreleased-changelog)");
  expect(JSON.stringify(job("bun_global_install_smoke"))).not.toContain(
    "OPENCLAW_BUN_GLOBAL_SMOKE_ALLOW_UNRELEASED_CHANGELOG",
  );
});
