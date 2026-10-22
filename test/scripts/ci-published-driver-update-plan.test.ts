import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
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
const updateWorkflow = readWorkflow(".github/workflows/ci-published-driver-update.yml");
const updateJob = updateWorkflow.jobs.update;
const updateStep = (name: string) => requiredWorkflowStep(updateJob.steps, name);
const actionStep = (action: string) =>
  updateJob.steps.find((step: WorkflowStep) =>
    action.endsWith("@") ? step.uses?.startsWith(action) : step.uses === action,
  );
const baseContext = {
  eventName: "workflow_dispatch",
  repository: "openclaw/openclaw",
  runAttempt: 1,
} as const;
const candidatePackage = "synthetic candidate package\n";
const cellScript = 'bash "$CELL_SCRIPT" "$CANDIDATE" "$ARTIFACTS"';
function fixture(
  label: string,
  inherited: NodeJS.ProcessEnv = { SystemRoot: process.env.SystemRoot, BASH_ENV: "", ENV: "" },
) {
  const root = tempDirs.make(`openclaw-published-driver-${label}-`);
  const file = (name: string, content?: string) => {
    const target = path.join(root, name);
    if (content !== undefined) {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    return target;
  };
  mkdirSync(file("bin"));
  return {
    file,
    read: (name: string) => readFileSync(file(name), "utf8"),
    executable: (name: string, lines: string[]) => writeExecutable(file(`bin/${name}`), lines),
    run: (script: string, env: NodeJS.ProcessEnv) =>
      runWorkflowShellScript(script, {
        cwd: root,
        env: {
          ...inherited,
          PATH: `${file("bin")}${path.delimiter}${process.env.PATH ?? ""}`,
          ...env,
        },
      }),
  };
}

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

it.each<
  [NonNullable<Parameters<typeof runCiManifestFixture>[0]["eventName"]>, string, boolean, boolean?]
>([
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
  },
);

it("keeps candidate execution in the caller revision and cache scope", () => {
  const checkout = actionStep("actions/checkout@");
  const revision = "a".repeat(40);
  expect(
    evaluateWorkflowExpression(checkout.with.ref, {
      ...baseContext,
      sha: revision,
      targetRef: "b".repeat(40),
    }),
  ).toBe(revision);
  expect(updateWorkflow.on.workflow_call.inputs.target_sha).toBeUndefined();
  expect(updateWorkflow.permissions).toEqual({ contents: "read" });
  expect(checkout.with["persist-credentials"]).toBe(false);
  expect(actionStep("./.github/actions/setup-node-env").with["cache-mode"]).toBe("off");
});

it("consumes only the candidate artifact produced by this run", () => {
  const workflow = readCiWorkflow();
  const caller = workflow.jobs["published-driver-update"];
  const producer = workflow.jobs["build-artifacts"];
  expect(caller.needs).toContain("build-artifacts");
  expect(caller.with).toMatchObject({
    candidate_artifact_id: "${{ needs.build-artifacts.outputs.published_driver_artifact_id }}",
    candidate_sha256: "${{ needs.build-artifacts.outputs.published_driver_sha256 }}",
  });
  expect(producer.outputs).toMatchObject({
    published_driver_artifact_id:
      "${{ steps.published_driver_package_upload.outputs.artifact-id }}",
    published_driver_sha256: "${{ steps.published_driver_package.outputs.sha256 }}",
  });
  const download = actionStep("actions/download-artifact@");
  expect(download.with["artifact-ids"]).toBe("${{ inputs.candidate_artifact_id }}");
  expect(download.with["run-id"]).toBeUndefined();
  expect(download.with["github-token"]).toBeUndefined();
  expect(actionStep("./.github/actions/setup-node-env").with["install-deps"]).toBe("false");
});

it.each<[number, number, boolean, boolean, boolean?]>([
  [124, 1, true, false],
  [137, 1, true, false],
  [42, 42, false, false],
  [0, 0, false, false],
  [0, 1, false, true],
  [0, 1, false, false, true],
] as const)(
  "reports command exit %s (expected=%s timeout=%s expired=%s checksum=%s) without cancelling the workflow",
  (commandExit, expectedExit, timedOut, expired, checksumMismatch = false) => {
    const f = fixture("budget", process.env);
    const actualSha256 = createHash("sha256").update(candidatePackage).digest("hex");
    const expectedSha256 = checksumMismatch ? "0".repeat(64) : actualSha256;
    f.file(".artifacts/published-driver-package/openclaw-candidate.tgz", candidatePackage);
    f.file("summary.md", "");
    f.executable("date", ["#!/bin/sh", "echo 1000"]);
    f.executable("timeout", [
      "#!/bin/sh",
      "printf '%s\\n' update > .artifacts/published-driver-update/phase.txt",
      `exit ${commandExit}`,
    ]);
    const step = updateStep("Update published driver to candidate");
    const result = f.run(step.run, {
      CELL_DEADLINE_EPOCH_SECONDS: expired ? "999" : "1525",
      CANDIDATE_SHA256: expectedSha256,
      DRIVER_VERSION: "2026.9.7",
      GITHUB_STEP_SUMMARY: f.file("summary.md"),
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(expectedExit);
    expect(updateJob["timeout-minutes"]).toBeUndefined();
    if (checksumMismatch) {
      expect(result.stdout).toContain(`expected=${expectedSha256} actual=${actualSha256}`);
      expect(result.stdout).toContain("::error title=Candidate checksum mismatch::");
      expect(existsSync(f.file(".artifacts/published-driver-update/phase.txt"))).toBe(false);
    } else if (expired) {
      expect(f.read("summary.md")).toContain("candidate preparation exhausted the cell budget");
    } else if (timedOut) {
      expect(result.stdout).toContain("::error title=Published-driver cell stopped::");
      expect(f.read("summary.md")).toContain(
        `timed out or was killed during update (exit ${commandExit})`,
      );
    } else {
      expect(f.read("summary.md")).toBe("");
    }
  },
);

it.each([
  ["pull_request", false, { ref: "refs/pull/42/merge" }],
  ["pull_request_target", false, {}],
  ["schedule", true, {}],
  ["push", true, {}],
  ["workflow_dispatch", true, {}],
  ["workflow_dispatch", false, { ref: "refs/heads/release" }],
  ["schedule", false, { hit: "true" }],
  ["push", false, { repository: "contributor/openclaw" }],
] as const)("cache authorization: %s / allowed=%s / %j", (eventName, allowed, overrides) => {
  const prepare = updateStep("Prepare main published driver seed");
  const save = actionStep("actions/cache/save@");
  const restore = actionStep("actions/cache/restore@");
  const driver = updateJob.steps.find((step: WorkflowStep) => step.id === "driver");
  const context = {
    ...baseContext,
    eventName,
    ref: "refs/heads/main",
    hit: "false",
    ...overrides,
  };
  const cacheMode = String(evaluateWorkflowExpression(driver.env.DRIVER_CACHE_MODE, context));
  const f = fixture("cache-mode");
  f.file(
    "scripts/lib/release-version.mjs",
    readFileSync("scripts/lib/release-version.mjs", "utf8"),
  );
  f.executable("npm", ["#!/bin/sh", `echo '"2026.9.7"'`]);
  const resolved = f.run(driver.run, {
    DRIVER_CACHE_MODE: cacheMode,
    GITHUB_OUTPUT: f.file("outputs"),
  });
  expect(resolved.status, `${resolved.stdout}${resolved.stderr}`).toBe(0);
  const driverOutputs = readWorkflowOutputs(f.file("outputs"));
  expect(driverOutputs).toEqual({ version: "2026.9.7", "cache-mode": cacheMode });
  for (const step of [prepare, save]) {
    expect(
      evaluateWorkflowExpression(`\${{ ${step.if} }}`, {
        ...context,
        steps: {
          driver: { outputs: driverOutputs },
          driver_cache: { outputs: { "cache-hit": context.hit } },
        },
      }),
    ).toBe(allowed);
  }
  expect(save.with.key).toBe(restore.with.key);
  expect(save.with.key).toContain("steps.driver.outputs.version");
  expect(restore.with["restore-keys"]).toBeUndefined();
});

it.each([0, 42])(
  "removes the private runtime volume after container exit %i with an existing image",
  (commandExit) => {
    const f = fixture("volume");
    const script = "scripts/e2e/published-driver-update-docker.sh";
    f.file(script, readFileSync(script, "utf8"));
    f.file("candidate.tgz", candidatePackage);
    // Only the wrapper is real; unexpected host Docker calls fail closed below.
    f.file(
      "scripts/lib/docker-e2e-image.sh",
      String.raw`
docker_e2e_resolve_image() { printf '%s\n' "$1"; }
docker_e2e_build_or_reuse() {
  [ "$1" = openclaw-published-driver-update-e2e ] || return 91
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
    f.executable("docker", [
      "#!/bin/sh",
      'printf "unexpected host Docker request\\n" > "$HOST_DOCKER_ATTEMPT"',
      "exit 97",
    ]);
    const result = f.run(cellScript, {
      HOME: f.file(""),
      CELL_SCRIPT: f.file(script),
      CANDIDATE: f.file("candidate.tgz"),
      ARTIFACTS: f.file("artifacts"),
      DOCKER_LOG: f.file("docker.log"),
      RUN_ARGS: f.file("run-args"),
      CONTAINER_EXIT: String(commandExit),
      HOST_DOCKER_ATTEMPT: f.file("host-docker-attempt"),
      OPENCLAW_SKIP_DOCKER_BUILD: "1",
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(commandExit);
    expect(existsSync(f.file("host-docker-attempt"))).toBe(false);
    const run = f.read("run-args").trim().split("\n");
    expect(run[run.indexOf("--mount") + 1]).toBe(
      "type=volume,source=fixture-runtime-volume,target=/tmp",
    );
    expect(f.read("docker.log").trim().split("\n")).toEqual([
      "image reuse",
      "volume create",
      "run",
      "volume rm fixture-runtime-volume",
    ]);
  },
);

it("gives direct callers and the release lane the CI cell envelope", () => {
  const { CELL_DEADLINE_EPOCH_SECONDS: _inherited, ...env } = process.env;
  const f = fixture("envelope", env);
  f.file("github.env", "");
  f.file("candidate.tgz", candidatePackage);
  f.executable("docker", [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    "const args = process.argv.slice(2);",
    'if (args[0] === "volume" && args[1] === "create") console.log("fixture-runtime-volume");',
    'if (args[0] === "run") {',
    `  fs.writeFileSync(${JSON.stringify(f.file("deadline.txt"))}, process.env.CELL_DEADLINE_EPOCH_SECONDS);`,
    '  fs.writeFileSync(args[args.indexOf("--cidfile") + 1], "fixture-container");',
    "}",
  ]);
  const budgetStep = updateStep("Start cell budget");

  const ciStarted = Math.floor(Date.now() / 1000);
  const ci = f.run(budgetStep.run, { GITHUB_ENV: f.file("github.env") });
  expect(ci.status, `${ci.stdout}${ci.stderr}`).toBe(0);
  const ciDeadline = /^CELL_DEADLINE_EPOCH_SECONDS=(\d+)$/m.exec(f.read("github.env"));
  const ciBudget = Number(ciDeadline?.[1]) - ciStarted;

  const directStarted = Math.floor(Date.now() / 1000);
  const direct = f.run(cellScript, {
    CELL_SCRIPT: path.resolve("scripts/e2e/published-driver-update-docker.sh"),
    CANDIDATE: f.file("candidate.tgz"),
    ARTIFACTS: f.file("artifacts"),
    OPENCLAW_SKIP_DOCKER_BUILD: "1",
  });
  expect(direct.status, `${direct.stdout}${direct.stderr}`).toBe(0);
  const directBudget = Number(f.read("deadline.txt")) - directStarted;

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
