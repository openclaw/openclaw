import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { evaluateWorkflowExpression, readCiWorkflow } from "./ci-workflow.test-support.js";

const workflow = readCiWorkflow();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const context = {
  eventName: "pull_request" as const,
  repository: "openclaw/openclaw",
  runAttempt: 1,
  readinessEnforced: true,
  readinessBroadCi: false,
  readinessResult: "success",
  readinessAttempt: 1,
  jobResults: { preflight: "skipped", "security-fast": "success", "check-shard": "skipped" },
};

it.each<{
  name: string;
  override: Partial<Parameters<typeof evaluateWorkflowExpression>[1]>;
  diagnostic: boolean;
}>([
  { name: "validated deferral", override: {}, diagnostic: true },
  { name: "ordinary admitted CI", override: { readinessBroadCi: true }, diagnostic: false },
  { name: "absent policy", override: { readinessEnforced: false }, diagnostic: false },
  { name: "failed admission", override: { readinessResult: "failure" }, diagnostic: false },
  { name: "cancelled admission", override: { readinessResult: "cancelled" }, diagnostic: false },
  { name: "skipped admission", override: { readinessResult: "skipped" }, diagnostic: false },
  { name: "stale attempt", override: { runAttempt: 2 }, diagnostic: false },
  {
    name: "failed preflight",
    override: { jobResults: { preflight: "failure" } },
    diagnostic: false,
  },
  {
    name: "failed security",
    override: { jobResults: { preflight: "skipped", "security-fast": "failure" } },
    diagnostic: false,
  },
  {
    name: "failed broad lane",
    override: { jobResults: { preflight: "skipped", "check-shard": "failure" } },
    diagnostic: false,
  },
  {
    name: "cancelled broad lane",
    override: { jobResults: { preflight: "skipped", "check-shard": "cancelled" } },
    diagnostic: false,
  },
])("$name selects only the appropriate producer check name", ({ override, diagnostic }) => {
  expect(
    evaluateWorkflowExpression(workflow.jobs["ci-gate"].name, { ...context, ...override }),
  ).toBe(diagnostic ? "CI deferred (not required)" : "openclaw/ci-gate");
});

it
  .skipIf(process.platform === "win32")
  .each([
    "valid",
    "off",
    "missing-policy",
    "invalid-policy",
    "missing-helper",
    "invalid-candidate",
    "closed",
    "stale-label",
  ])("real readiness step classifies %s before diagnostic naming", (scenario) => {
  const directory = tempDirs.make("readiness-deferred-");
  mkdirSync(join(directory, ".github"));
  const policy = { version: 1, mode: scenario === "off" ? "off" : "all", pullRequests: [] };
  if (scenario !== "missing-policy") {
    writeFileSync(
      join(directory, ".github/ci-readiness.json"),
      JSON.stringify(scenario === "invalid-policy" ? {} : policy),
    );
  }
  const pr = {
    number: 42,
    state: scenario === "closed" ? "closed" : "open",
    draft: false,
    head: {
      sha: scenario === "invalid-candidate" ? "" : "a".repeat(40),
      ref: "topic",
      repo: { full_name: context.repository },
    },
    base: { sha: "b".repeat(40), ref: "main", repo: { full_name: context.repository } },
  };
  const event = {
    action: scenario === "stale-label" ? "labeled" : "synchronize",
    label: { name: "ci:ready:stale" },
    pull_request: pr,
  };
  writeFileSync(join(directory, "event.json"), JSON.stringify(event));
  const step = workflow.jobs.readiness.steps.find(
    (item: { id?: string }) => item.id === "readiness",
  );
  const helper =
    scenario === "missing-helper"
      ? join(directory, "absent.mjs")
      : resolve("scripts/ci-readiness.mjs");
  const result = spawnSync(
    "bash",
    ["-c", step.run.replace("node scripts/ci-readiness.mjs", `node '${helper}'`)],
    {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_REPOSITORY: context.repository,
        GITHUB_EVENT_PATH: join(directory, "event.json"),
        GITHUB_SHA: "c".repeat(40),
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_OUTPUT: join(directory, "output"),
        GITHUB_STEP_SUMMARY: join(directory, "summary"),
        PR_OPEN: "true",
        LABEL_EVENT: "false",
      },
    },
  );
  expect(result.status, result.stdout + result.stderr).toBe(
    ["valid", "off", "missing-policy"].includes(scenario) ? 0 : 1,
  );
  const outputs = Object.fromEntries(
    readFileSync(join(directory, "output"), "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
  const name = evaluateWorkflowExpression(workflow.jobs["ci-gate"].name, {
    ...context,
    githubEvent: event,
    readinessResult: result.status === 0 ? "success" : "failure",
    readinessEnforced: outputs.enforced === "true",
    readinessBroadCi: outputs.broad_ci === "true",
    readinessAttempt: Number(outputs.attempt),
  });
  expect(name).toBe(scenario === "valid" ? "CI deferred (not required)" : "openclaw/ci-gate");
  if (scenario === "valid") {
    const gate = workflow.jobs["ci-gate"].steps.find(
      (item: { name: string }) => item.name === "Verify selected CI lanes",
    );
    const diagnostic = spawnSync("bash", ["-c", gate.run], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "pull_request",
        READINESS_RESULT: "success",
        BROAD_CI: "false",
      },
    });
    expect(diagnostic.status).toBe(1);
    expect(diagnostic.stdout).toContain("Broad CI was not admitted for this exact PR candidate");
  }
});
