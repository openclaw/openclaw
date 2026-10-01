import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { shouldRunPublishedDriverUpdate } from "../../scripts/lib/ci-published-driver-update-plan.mts";
import { mainLanes } from "../../scripts/lib/docker-e2e-scenarios.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { runCiManifestFixture } from "./ci-workflow-manifest.test-support.js";
import {
  evaluateWorkflowExpression,
  readCiWorkflow,
  readWorkflow,
  runWorkflowShellScript,
  type WorkflowStep,
  writeExecutable,
} from "./ci-workflow.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("published-driver update selection", () => {
  it.each([
    "src/infra/update-runner.ts",
    "src/cli/update-cli/update-command.ts",
    "src/state/openclaw-state-lease.ts",
    "src/state/openclaw-state-lease-identity.ts",
    "src/state/openclaw-state-db-open.ts",
    "src/infra/sqlite-file-identity.ts",
    "src/plugins/plugin-native-assignments.ts",
    "src/cli/startup-trace.ts",
    "src/gateway/server-startup-trace.ts",
    "scripts/update-gateway.sh",
    "scripts/lib/source-update-build.mts",
    "scripts/lib/update-compat-chunks.mts",
    "scripts/e2e/update-first-hop-compat-docker.sh",
    "scripts/e2e/lib/upgrade-survivor/assertions.mjs",
    "scripts/e2e/plugin-update-unchanged-docker.sh",
    "scripts/e2e/lib/plugin-update/consent-scenario.mjs",
    "scripts/e2e/parallels/npm-update-smoke.ts",
    "scripts/lib/release-upgrade-baseline.mjs",
    "scripts/lib/cross-os-release-checks/packaged-self-update.ts",
    "scripts/test-update-cli-startup-bench.mts",
    "scripts/doctor-config-upgrade-replay.mjs",
    "scripts/package-openclaw-for-docker.mts",
    "scripts/e2e/published-driver-update-docker.sh",
    "scripts/lib/ci-published-driver-update-plan.mts",
    ".github/workflows/ci-published-driver-update.yml",
    ".github/workflows/ci.yml",
    "src\\state\\openclaw-state-lease.ts",
  ])("requires the cross-version cell for %s", (file) => {
    expect(shouldRunPublishedDriverUpdate([file])).toBe(true);
  });

  it.each([
    "docs/install/updating.md",
    "src/agents/context-window-guard.ts",
    "src/state/openclaw-state-schema.ts",
    "src/plugins/plugin-manifest.ts",
    "scripts/format-docs.mts",
    "ui/src/app.ts",
  ])("omits unrelated owner %s", (file) => {
    expect(shouldRunPublishedDriverUpdate([file])).toBe(false);
  });

  it.each([{ paths: null }, { paths: [] }, { paths: [""] }])(
    "retains coverage for an unavailable diff $paths",
    ({ paths }) => {
      expect(shouldRunPublishedDriverUpdate(paths)).toBe(true);
    },
  );

  it.each([
    { eventName: "pull_request", file: "src/state/openclaw-state-lease.ts", selected: true },
    { eventName: "pull_request", file: "src/agents/context-window-guard.ts", selected: false },
    { eventName: "push", file: "src/agents/context-window-guard.ts", selected: true },
    { eventName: "workflow_dispatch", file: "src/agents/context-window-guard.ts", selected: true },
    { eventName: "schedule", file: "src/agents/context-window-guard.ts", selected: true },
    { eventName: "pull_request", file: "scripts/update-gateway.sh", selected: true },
  ] as const)("connects $eventName $file to the required job", ({ eventName, file, selected }) => {
    const result = runCiManifestFixture({
      bundledPlanner: true,
      historicalCompatibility: false,
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
      evaluateWorkflowExpression(`\${{ ${job.if} }}`, {
        eventName,
        repository: "openclaw/openclaw",
        runAttempt: 1,
        sha: revision,
        preflightOutputs: { ...result.outputs, checkout_revision: revision },
      }),
    ).toBe(selected);
  });

  it("keeps candidate execution in the caller revision and cache scope", () => {
    const workflow = readWorkflow(".github/workflows/ci-published-driver-update.yml");
    const job = workflow.jobs.update;
    const checkout = job.steps.find((step: WorkflowStep) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    const revision = "a".repeat(40);
    expect(
      evaluateWorkflowExpression(checkout.with.ref, {
        eventName: "workflow_dispatch",
        repository: "openclaw/openclaw",
        runAttempt: 1,
        sha: revision,
        targetRef: "b".repeat(40),
      }),
    ).toBe(revision);
    expect(workflow.on.workflow_call.inputs.target_sha).toBeUndefined();
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(checkout.with["persist-credentials"]).toBe(false);
    expect(
      job.steps.find((step: WorkflowStep) => step.uses === "./.github/actions/setup-node-env").with[
        "cache-mode"
      ],
    ).toBe("off");
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
    const consumer = readWorkflow(".github/workflows/ci-published-driver-update.yml").jobs.update;
    const download = consumer.steps.find((step: WorkflowStep) =>
      step.uses?.startsWith("actions/download-artifact@"),
    );
    expect(download.with["artifact-ids"]).toBe("${{ inputs.candidate_artifact_id }}");
    expect(download.with["run-id"]).toBeUndefined();
    expect(download.with["github-token"]).toBeUndefined();
    expect(
      consumer.steps.find((step: WorkflowStep) => step.uses === "./.github/actions/setup-node-env")
        .with["install-deps"],
    ).toBe("false");
  });

  it.each<{
    commandExit: number;
    expectedExit: number;
    timedOut: boolean;
    expired: boolean;
    checksumMismatch?: boolean;
  }>([
    { commandExit: 124, expectedExit: 1, timedOut: true, expired: false },
    { commandExit: 137, expectedExit: 1, timedOut: true, expired: false },
    { commandExit: 42, expectedExit: 42, timedOut: false, expired: false },
    { commandExit: 0, expectedExit: 0, timedOut: false, expired: false },
    { commandExit: 0, expectedExit: 1, timedOut: false, expired: true },
    { commandExit: 0, expectedExit: 1, timedOut: false, expired: false, checksumMismatch: true },
  ])(
    "reports command exit $commandExit with expired=$expired checksumMismatch=$checksumMismatch without cancelling the workflow",
    ({ commandExit, expectedExit, timedOut, expired, checksumMismatch }) => {
      const root = tempDirs.make("openclaw-published-driver-budget-");
      const packageDirectory = path.join(root, ".artifacts/published-driver-package");
      const bin = path.join(root, "bin");
      mkdirSync(packageDirectory, { recursive: true });
      mkdirSync(bin);
      const candidate = "synthetic candidate package\n";
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
      const job = readWorkflow(".github/workflows/ci-published-driver-update.yml").jobs.update;
      const step = job.steps.find(
        (candidateStep: WorkflowStep) =>
          candidateStep.name === "Update published driver to candidate",
      );
      const result = runWorkflowShellScript(step.run, {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          CELL_DEADLINE_EPOCH_SECONDS: expired ? "999" : "1525",
          CANDIDATE_SHA256: expectedSha256,
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

  it.each([0, 42])("removes the private runtime volume after container exit %i", (commandExit) => {
    const root = tempDirs.make("openclaw-published-driver-volume-");
    const bin = path.join(root, "bin");
    const log = path.join(root, "docker.jsonl");
    const candidate = path.join(root, "candidate.tgz");
    mkdirSync(bin);
    writeFileSync(candidate, "synthetic candidate package\n");
    writeExecutable(path.join(bin, "docker"), [
      `#!${process.execPath}`,
      'const fs = require("node:fs");',
      "const args = process.argv.slice(2);",
      `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");`,
      'if (args[0] === "volume" && args[1] === "create") console.log("fixture-runtime-volume");',
      'if (args[0] === "run") {',
      '  fs.writeFileSync(args[args.indexOf("--cidfile") + 1], "fixture-container");',
      `  process.exit(${commandExit});`,
      "}",
    ]);
    const result = runWorkflowShellScript('bash "$CELL_SCRIPT" "$CANDIDATE" "$ARTIFACTS"', {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        CELL_SCRIPT: path.resolve("scripts/e2e/published-driver-update-docker.sh"),
        CANDIDATE: candidate,
        ARTIFACTS: path.join(root, "artifacts"),
        OPENCLAW_SKIP_DOCKER_BUILD: "1",
      },
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(commandExit);
    const commands = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const run = commands.find((args) => args[0] === "run")!;
    expect(run[run.indexOf("--mount") + 1]).toBe(
      "type=volume,source=fixture-runtime-volume,target=/tmp",
    );
    expect(commands.indexOf(run)).toBeGreaterThan(
      commands.findIndex((args) => args[0] === "volume" && args[1] === "create"),
    );
    const containerRemoved = commands.findIndex(
      (args) => args[0] === "rm" && args.includes("fixture-container"),
    );
    expect(containerRemoved).toBeGreaterThan(commands.indexOf(run));
    expect(commands.at(-1)).toEqual(["volume", "rm", "fixture-runtime-volume"]);
  });

  it("gives direct callers and the release lane the CI cell envelope", () => {
    const root = tempDirs.make("openclaw-published-driver-envelope-");
    const bin = path.join(root, "bin");
    const githubEnv = path.join(root, "github.env");
    const received = path.join(root, "deadline.txt");
    const candidate = path.join(root, "candidate.tgz");
    mkdirSync(bin);
    writeFileSync(githubEnv, "");
    writeFileSync(candidate, "synthetic candidate package\n");
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
    const budgetStep = readWorkflow(
      ".github/workflows/ci-published-driver-update.yml",
    ).jobs.update.steps.find((step: WorkflowStep) => step.name === "Start cell budget");

    const ciStarted = Math.floor(Date.now() / 1000);
    const ci = runWorkflowShellScript(budgetStep.run, {
      cwd: root,
      env: { ...env, GITHUB_ENV: githubEnv },
    });
    expect(ci.status, `${ci.stdout}${ci.stderr}`).toBe(0);
    const ciDeadline = /^CELL_DEADLINE_EPOCH_SECONDS=(\d+)$/m.exec(readFileSync(githubEnv, "utf8"));
    const ciBudget = Number(ciDeadline?.[1]) - ciStarted;

    const directStarted = Math.floor(Date.now() / 1000);
    const direct = runWorkflowShellScript('bash "$CELL_SCRIPT" "$CANDIDATE" "$ARTIFACTS"', {
      cwd: root,
      env: {
        ...env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
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
      eventName: "workflow_dispatch" as const,
      repository: "openclaw/openclaw",
      runAttempt: 1,
      sha: "a".repeat(40),
      preflightOutputs: {
        run_published_driver_update: "true",
        checkout_revision: "b".repeat(40),
      },
    };
    expect(
      evaluateWorkflowExpression(`\${{ ${workflow.jobs["published-driver-update"].if} }}`, context),
    ).toBe(false);
    const notice = workflow.jobs["ci-gate"].steps.find(
      (step: WorkflowStep) => step.name === "Record published-driver dispatch limitation",
    );
    expect(evaluateWorkflowExpression(`\${{ ${notice.if} }}`, context)).toBe(true);
    expect(notice.run).toContain("no published-driver cell proof for the selected revision");
  });

  it("omits the cell for frozen targets that predate its harness", () => {
    const result = runCiManifestFixture({
      bundledPlanner: true,
      historicalCompatibility: true,
      publishedDriverUpdateCapability: false,
      eventName: "workflow_dispatch",
    });
    expect(result.status, result.output).toBe(0);
    expect(result.outputs.run_published_driver_update).toBe("false");
  });
});
