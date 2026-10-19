import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { shouldRunPublishedDriverUpdate } from "../../scripts/lib/ci-published-driver-update-plan.mts";
import { mainLanes } from "../../scripts/lib/docker-e2e-scenarios.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { runCiManifestFixture } from "./ci-workflow-manifest.test-support.js";
import {
  evaluateWorkflowExpression,
  evaluateWorkflowCondition,
  readCiWorkflow,
  readWorkflow,
  readWorkflowOutputs,
  runWorkflowShellScript,
  type WorkflowStep,
  requiredWorkflowStep,
  writeExecutable,
} from "./ci-workflow.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const updateJob = () =>
  readWorkflow(".github/workflows/ci-published-driver-update.yml").jobs.update;
const updateStep = (name: string) => requiredWorkflowStep(updateJob().steps, name);
const actionStep = (job: ReturnType<typeof updateJob>, action: string) =>
  job.steps.find((step: WorkflowStep) =>
    action.endsWith("@") ? step.uses?.startsWith(action) : step.uses === action,
  );
const baseContext = {
  eventName: "workflow_dispatch",
  repository: "openclaw/openclaw",
  runAttempt: 1,
} as const;
const candidatePackage = "synthetic candidate package\n";
const cellScript = 'bash "$CELL_SCRIPT" "$CANDIDATE" "$ARTIFACTS"';
const fixturePath = (bin: string) => `${bin}${path.delimiter}${process.env.PATH ?? ""}`;

describe("published-driver update selection", () => {
  it.each([
    { paths: ["src\\infra\\update-runner.ts"], expected: true },
    { paths: ["src/cli/update-cli/update-command.ts"], expected: true },
    { paths: ["src/cli/runtime-cleanup-scope.ts"], expected: true },
    { paths: ["src/cli/runtime-cleanup.ts"], expected: true },
    { paths: ["src/cli/startup-trace.ts"], expected: true },
    { paths: ["src/gateway/server-startup-trace.ts"], expected: true },
    { paths: ["src/state/openclaw-state-lease.ts"], expected: false },
    { paths: ["scripts/update-gateway.sh"], expected: false },
    { paths: null, expected: true },
    { paths: [], expected: true },
    { paths: [""], expected: true },
  ])("retains dispatch owner selection for $paths: $expected", ({ paths, expected }) => {
    expect(shouldRunPublishedDriverUpdate(paths, "workflow_dispatch")).toBe(expected);
    expect(shouldRunPublishedDriverUpdate(paths, "pull_request")).toBe(false);
  });

  it.each([
    ["pull_request", "src/infra/update-managed-service-handoff.ts", false],
    ["pull_request", "src/state/openclaw-state-lease.ts", false],
    ["push", "src/agents/context-window-guard.ts", true],
    ["workflow_dispatch", "src/plugins/plugin-native-assignments.ts", true],
    ["schedule", "src/state/openclaw-state-db-open.ts", true],
    ["pull_request", "scripts/update-gateway.sh", false],
    ["workflow_dispatch", "src/infra/update-runner.ts", false, true],
  ] as const)(
    "connects %s %s to the required job",
    (eventName, file, selected, historical = false) => {
      const result = runCiManifestFixture({
        bundledPlanner: true,
        historicalCompatibility: historical,
        publishedDriverUpdateCapability: !historical,
        eventName,
        changedPaths: [file],
        runNode: file !== "scripts/update-gateway.sh",
        scopeEnv:
          eventName === "schedule"
            ? {
                OPENCLAW_CI_VALIDATION_TIER: "main",
                OPENCLAW_CI_WORKFLOW_REVISION: "a".repeat(40),
              }
            : {},
      });
      expect(result.status, result.output).toBe(0);
      expect(result.outputs.run_published_driver_update).toBe(String(selected));
      if (selected) {
        expect(result.outputs.run_build_artifacts).toBe("true");
      }
      const job = readCiWorkflow().jobs["published-driver-update"];
      const revision = "a".repeat(40);
      expect(
        evaluateWorkflowCondition(job.if, {
          ...baseContext,
          eventName,
          sha: revision,
          additionalNeeds: {
            "build-artifacts": {
              result: "failure",
              outputs: { published_driver_artifact_id: "fixture-run-artifact" },
            },
          },
          preflightOutputs: { ...result.outputs, checkout_revision: revision },
        }),
      ).toBe(selected);
    },
  );

  it("keeps candidate execution in the caller revision and cache scope", () => {
    const workflow = readWorkflow(".github/workflows/ci-published-driver-update.yml");
    const job = workflow.jobs.update;
    const checkout = actionStep(job, "actions/checkout@");
    const revision = "a".repeat(40);
    expect(
      evaluateWorkflowExpression(checkout.with.ref, {
        ...baseContext,
        sha: revision,
        targetRef: "b".repeat(40),
      }),
    ).toBe(revision);
    expect(workflow.on.workflow_call.inputs.target_sha).toBeUndefined();
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(checkout.with["persist-credentials"]).toBe(false);
    expect(actionStep(job, "./.github/actions/setup-node-env").with["cache-mode"]).toBe("off");
  });

  it("consumes only the candidate artifact produced by this run", () => {
    const workflow = readCiWorkflow();
    const caller = workflow.jobs["published-driver-update"];
    const producer = workflow.jobs["build-artifacts"];
    expect(caller.needs).toContain("build-artifacts");
    for (const [input, output] of [
      ["candidate_artifact_id", "published_driver_artifact_id"],
      ["candidate_sha256", "published_driver_sha256"],
    ] as const) {
      expect(caller.with[input]).toBe(`\${{ needs.build-artifacts.outputs.${output} }}`);
    }
    expect(producer.outputs.published_driver_artifact_id).toBe(
      "${{ steps.published_driver_package_upload.outputs.artifact-id }}",
    );
    expect(producer.outputs.published_driver_sha256).toBe(
      "${{ steps.published_driver_package.outputs.sha256 }}",
    );
    const consumer = updateJob();
    const download = actionStep(consumer, "actions/download-artifact@");
    expect(download.with["artifact-ids"]).toBe("${{ inputs.candidate_artifact_id }}");
    expect(download.with["run-id"]).toBeUndefined();
    expect(download.with["github-token"]).toBeUndefined();
    expect(actionStep(consumer, "./.github/actions/setup-node-env").with["install-deps"]).toBe(
      "false",
    );
  });

  it.each([
    [124, 1, true, false],
    [137, 1, true, false],
    [42, 42, false, false],
    [0, 0, false, false],
    [0, 1, false, true],
    [0, 1, false, false, true],
  ] as const)(
    "reports command exit %s (expected=%s timeout=%s expired=%s checksum=%s) without cancelling the workflow",
    (commandExit, expectedExit, timedOut, expired, checksumMismatch = false) => {
      const root = tempDirs.make("openclaw-published-driver-budget-");
      const packageDirectory = path.join(root, ".artifacts/published-driver-package");
      const bin = path.join(root, "bin");
      mkdirSync(packageDirectory, { recursive: true });
      mkdirSync(bin);
      const candidate = candidatePackage;
      const actualSha256 = createHash("sha256").update(candidate).digest("hex");
      const expectedSha256 = checksumMismatch ? "0".repeat(64) : actualSha256;
      writeFileSync(path.join(packageDirectory, "openclaw-candidate.tgz"), candidate);
      const summary = path.join(root, "summary.md");
      writeFileSync(summary, "");
      writeExecutable(path.join(bin, "date"), ["#!/bin/sh", "echo 1000"]);
      writeExecutable(path.join(bin, "timeout"), [
        "#!/bin/sh",
        "printf '%s\\n' update > .artifacts/published-driver-update/phase.txt",
        `exit ${commandExit}`,
      ]);
      const job = updateJob();
      const step = updateStep("Update published driver to candidate");
      const result = runWorkflowShellScript(step.run, {
        cwd: root,
        env: {
          ...process.env,
          PATH: fixturePath(bin),
          CELL_DEADLINE_EPOCH_SECONDS: expired ? "999" : "1525",
          CANDIDATE_SHA256: expectedSha256,
          DRIVER_VERSION: "2026.9.7",
          GITHUB_STEP_SUMMARY: summary,
        },
      });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(expectedExit);
      expect(job["timeout-minutes"]).toBeUndefined();
      if (checksumMismatch) {
        expect(result.stdout).toContain(`expected=${expectedSha256} actual=${actualSha256}`);
        expect(result.stdout).toContain("::error title=Candidate checksum mismatch::");
        expect(existsSync(path.join(root, ".artifacts/published-driver-update/phase.txt"))).toBe(
          false,
        );
      } else if (expired) {
        expect(readFileSync(summary, "utf8")).toContain(
          "candidate preparation exhausted the cell budget",
        );
      } else if (timedOut) {
        expect(result.stdout).toContain("::error title=Published-driver cell stopped::");
        expect(readFileSync(summary, "utf8")).toContain(
          `timed out or was killed during update (exit ${commandExit})`,
        );
      } else {
        expect(readFileSync(summary, "utf8")).toBe("");
      }
    },
  );

  it.each<{
    eventName: Parameters<typeof evaluateWorkflowExpression>[1]["eventName"];
    ref: string;
    hit: string;
    allowed: boolean;
    repository?: string;
  }>([
    { eventName: "pull_request", ref: "refs/pull/42/merge", hit: "false", allowed: false },
    { eventName: "pull_request_target", ref: "refs/heads/main", hit: "false", allowed: false },
    { eventName: "schedule", ref: "refs/heads/main", hit: "false", allowed: true },
    { eventName: "push", ref: "refs/heads/main", hit: "false", allowed: true },
    { eventName: "workflow_dispatch", ref: "refs/heads/main", hit: "false", allowed: true },
    { eventName: "workflow_dispatch", ref: "refs/heads/release", hit: "false", allowed: false },
    { eventName: "schedule", ref: "refs/heads/main", hit: "true", allowed: false },
    {
      eventName: "push",
      ref: "refs/heads/main",
      hit: "false",
      allowed: false,
      repository: "contributor/openclaw",
    },
  ])("writes driver cache for $eventName $ref hit=$hit: $allowed", (scenario) => {
    const job = updateJob();
    const prepare = updateStep("Prepare main published driver seed");
    const save = actionStep(job, "actions/cache/save@");
    const restore = actionStep(job, "actions/cache/restore@");
    const driver = job.steps.find((step: WorkflowStep) => step.id === "driver");
    const context = {
      ...baseContext,
      eventName: scenario.eventName,
      ref: scenario.ref,
      repository: scenario.repository ?? "openclaw/openclaw",
    };
    const cacheMode = String(evaluateWorkflowExpression(driver.env.DRIVER_CACHE_MODE, context));
    const root = tempDirs.make("openclaw-published-driver-cache-mode-");
    const bin = path.join(root, "bin");
    const lib = path.join(root, "scripts/lib");
    const output = path.join(root, "outputs");
    mkdirSync(bin);
    mkdirSync(lib, { recursive: true });
    copyFileSync("scripts/lib/release-version.mjs", path.join(lib, "release-version.mjs"));
    writeExecutable(path.join(bin, "npm"), ["#!/bin/sh", `echo '"2026.9.7"'`]);
    const resolved = runWorkflowShellScript(driver.run, {
      cwd: root,
      env: {
        PATH: fixturePath(bin),
        SystemRoot: process.env.SystemRoot,
        BASH_ENV: "",
        ENV: "",
        DRIVER_CACHE_MODE: cacheMode,
        GITHUB_OUTPUT: output,
      },
    });
    expect(resolved.status, `${resolved.stdout}${resolved.stderr}`).toBe(0);
    const driverOutputs = readWorkflowOutputs(output);
    expect(driverOutputs).toEqual({ version: "2026.9.7", "cache-mode": cacheMode });
    for (const step of [prepare, save]) {
      expect(
        evaluateWorkflowExpression(`\${{ ${step.if} }}`, {
          ...context,
          steps: {
            driver: { outputs: driverOutputs },
            driver_cache: { outputs: { "cache-hit": scenario.hit } },
          },
        }),
      ).toBe(scenario.allowed);
    }
    expect(save.with.key).toBe(restore.with.key);
    expect(save.with.key).toContain("steps.driver.outputs.version");
    expect(restore.with["restore-keys"]).toBeUndefined();
  });

  it.each([0, 42])(
    "removes the private runtime volume after container exit %i with an existing image",
    (commandExit) => {
      const root = tempDirs.make("openclaw-published-driver-volume-");
      const bin = path.join(root, "bin");
      const log = path.join(root, "docker.log");
      const runArgs = path.join(root, "run-args");
      const imageState = path.join(root, "existing-image");
      const hostDockerAttempt = path.join(root, "host-docker-attempt");
      const candidate = path.join(root, "candidate.tgz");
      const script = path.join(root, "scripts/e2e/published-driver-update-docker.sh");
      const helpers = path.join(root, "scripts/lib");
      mkdirSync(bin);
      mkdirSync(path.dirname(script), { recursive: true });
      mkdirSync(helpers);
      copyFileSync("scripts/e2e/published-driver-update-docker.sh", script);
      writeFileSync(candidate, candidatePackage);
      writeFileSync(imageState, "openclaw-published-driver-update-e2e\n");
      // Exercise the wrapper's volume ownership; the shared container owner has
      // its own tests. No helper in this fixture can fall through to host Docker.
      writeFileSync(
        path.join(helpers, "docker-e2e-image.sh"),
        String.raw`
# The real helper sources the package helper; the cell script relies on that.
source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"
docker_e2e_resolve_image() { printf '%s\n' "$1"; }
docker_e2e_build_or_reuse() {
  [ "$(cat "$IMAGE_STATE")" = "$1" ] || return 91
  printf 'image reuse\n' >> "$DOCKER_LOG"
}
docker_e2e_docker_cmd() {
  printf '%s\n' "$*" >> "$DOCKER_LOG"
  case "$*" in
    'volume create') printf 'fixture-runtime-volume\n' ;;
    'volume rm fixture-runtime-volume') ;;
    *) return 92 ;;
  esac
}
`,
      );
      writeFileSync(
        path.join(helpers, "docker-e2e-package.sh"),
        String.raw`
docker_e2e_prepare_package_tgz() { printf '%s\n' "$2"; }
docker_e2e_cleanup_package_tgz() { :; }
docker_e2e_package_mount_args() { DOCKER_E2E_PACKAGE_ARGS=(-v "$1:/tmp/openclaw-current.tgz:ro"); }
docker_e2e_run_with_harness() {
  printf 'run\n' >> "$DOCKER_LOG"
  printf '%s\n' "$@" > "$RUN_ARGS"
  return "$CONTAINER_EXIT"
}
`,
      );
      writeExecutable(path.join(bin, "docker"), [
        "#!/bin/sh",
        'printf "unexpected host Docker request\\n" > "$HOST_DOCKER_ATTEMPT"',
        "exit 97",
      ]);
      const result = runWorkflowShellScript(cellScript, {
        cwd: root,
        env: {
          PATH: fixturePath(bin),
          SystemRoot: process.env.SystemRoot,
          HOME: root,
          BASH_ENV: "",
          ENV: "",
          CELL_SCRIPT: script,
          CANDIDATE: candidate,
          ARTIFACTS: path.join(root, "artifacts"),
          IMAGE_STATE: imageState,
          DOCKER_LOG: log,
          RUN_ARGS: runArgs,
          CONTAINER_EXIT: String(commandExit),
          HOST_DOCKER_ATTEMPT: hostDockerAttempt,
          OPENCLAW_SKIP_DOCKER_BUILD: "1",
        },
      });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(commandExit);
      expect(existsSync(hostDockerAttempt)).toBe(false);
      const run = readFileSync(runArgs, "utf8").trim().split("\n");
      expect(run[run.indexOf("--mount") + 1]).toBe(
        "type=volume,source=fixture-runtime-volume,target=/tmp",
      );
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "image reuse",
        "volume create",
        "run",
        "volume rm fixture-runtime-volume",
      ]);
    },
  );

  it("gives direct callers and the release lane the CI cell envelope", () => {
    const root = tempDirs.make("openclaw-published-driver-envelope-");
    const bin = path.join(root, "bin");
    const githubEnv = path.join(root, "github.env");
    const received = path.join(root, "deadline.txt");
    const candidate = path.join(root, "candidate.tgz");
    mkdirSync(bin);
    writeFileSync(githubEnv, "");
    writeFileSync(candidate, candidatePackage);
    writeExecutable(path.join(bin, "docker"), [
      `#!${process.execPath}`,
      'const fs = require("node:fs");',
      "const args = process.argv.slice(2);",
      'if (args[0] === "volume" && args[1] === "create") console.log("fixture-runtime-volume");',
      'if (args[0] === "run") {',
      `  fs.writeFileSync(${JSON.stringify(received)}, process.env.CELL_DEADLINE_EPOCH_SECONDS);`,
      '  fs.writeFileSync(args[args.indexOf("--cidfile") + 1], "fixture-container");',
      "}",
    ]);
    const { CELL_DEADLINE_EPOCH_SECONDS: _inherited, ...env } = process.env;
    const budgetStep = updateStep("Start cell budget");

    const ciStarted = Math.floor(Date.now() / 1000);
    const ci = runWorkflowShellScript(budgetStep.run, {
      cwd: root,
      env: { ...env, GITHUB_ENV: githubEnv },
    });
    expect(ci.status, `${ci.stdout}${ci.stderr}`).toBe(0);
    const ciDeadline = /^CELL_DEADLINE_EPOCH_SECONDS=(\d+)$/m.exec(readFileSync(githubEnv, "utf8"));
    const ciBudget = Number(ciDeadline?.[1]) - ciStarted;

    const directStarted = Math.floor(Date.now() / 1000);
    const direct = runWorkflowShellScript(cellScript, {
      cwd: root,
      env: {
        ...env,
        PATH: fixturePath(bin),
        CELL_SCRIPT: path.resolve("scripts/e2e/published-driver-update-docker.sh"),
        CANDIDATE: candidate,
        ARTIFACTS: path.join(root, "artifacts"),
        OPENCLAW_SKIP_DOCKER_BUILD: "1",
      },
    });
    expect(direct.status, `${direct.stdout}${direct.stderr}`).toBe(0);
    const directBudget = Number(readFileSync(received, "utf8")) - directStarted;

    // Second-boundary crossings between date calls can shift either reading by one.
    expect(Math.abs(directBudget - ciBudget)).toBeLessThanOrEqual(2);
    const releaseLane = mainLanes.find((lane) => lane.name === "published-driver-update");
    expect(releaseLane?.timeoutMs).toBeGreaterThan(ciBudget * 1000);
  });

  it("records the omitted cell when a dispatch fallback selects a different revision", () => {
    const workflow = readCiWorkflow();
    const context = {
      ...baseContext,
      sha: "a".repeat(40),
      additionalNeeds: {
        "build-artifacts": { outputs: { published_driver_artifact_id: "fixture-run-artifact" } },
      },
      preflightOutputs: {
        run_published_driver_update: "true",
        checkout_revision: "b".repeat(40),
      },
    };
    expect(evaluateWorkflowCondition(workflow.jobs["published-driver-update"].if, context)).toBe(
      false,
    );
    const notice = workflow.jobs["ci-gate"].steps.find(
      (step: WorkflowStep) => step.name === "Record published-driver dispatch limitation",
    );
    expect(evaluateWorkflowCondition(notice.if, context)).toBe(true);
    expect(notice.run).toContain("no published-driver cell proof for the selected revision");
  });
});
