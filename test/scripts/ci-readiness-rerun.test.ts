import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readinessLabel } from "../../scripts/ci-readiness.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { evaluateWorkflowExpression, readCiWorkflow } from "./ci-workflow.test-support.js";

const workflow = readCiWorkflow();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repository = "openclaw/openclaw";
const head = "a".repeat(40);
const base = "b".repeat(40);
const tested = "c".repeat(40);
const broadJobs = Object.entries(workflow.jobs).filter(
  ([id]) =>
    ![
      "readiness",
      "preflight",
      "security-fast",
      "ci-gate",
      "seal_release_child_evidence",
      "ios-release-e2e",
      "pr-failure-report",
    ].includes(id),
);

describe("attempt-bound workflow entry paths", () => {
  it("accounts for all 35 PR workloads without admitting release-only jobs", () => {
    const ids = broadJobs.map(([id]) => id);
    expect(ids).toHaveLength(35);
    expect(ids).toEqual(
      expect.arrayContaining([
        "check-plan",
        "checks-baseline-ratchets",
        "android-access-native",
        "android-screenshots",
        "check-extension-package-boundary",
        "published-driver-update",
      ]),
    );
    const gate = workflow.jobs["ci-gate"];
    expect(gate.needs.toSorted()).toEqual(
      [
        "readiness",
        "preflight",
        "security-fast",
        ...ids,
        "ios-release-e2e",
        "pr-failure-report",
      ].toSorted(),
    );
    const verifyStep = gate.steps.find(
      (step: { name: string }) => step.name === "Verify selected CI lanes",
    );
    expect(Object.keys(verifyStep.env)).toEqual([
      "READINESS_RESULT",
      "READINESS_AUTHORITY_RESULT",
      "READINESS_ATTEMPT",
      "READINESS_ENFORCED",
      "READINESS_REQUEST_ID",
      "BROAD_CI",
      "RELEASE_FAST_LANE",
      "ALLOW_COALESCED_IOS",
      "ALLOW_KNOWN_MAIN_RED",
      "JOB_RESULTS",
    ]);
    const results = verifyStep.env.JOB_RESULTS;
    expect(
      results
        .trim()
        .split("\n")
        .map((row: string) => row.split("=")[0])
        .toSorted(),
    ).toEqual(
      ["preflight", "security-fast", ...ids, "ios-release-e2e", "pr-failure-report"].toSorted(),
    );
    for (const runAttempt of [1, 2]) {
      expect(
        evaluateWorkflowExpression(workflow.jobs["ios-release-e2e"].if, {
          eventName: "pull_request",
          repository,
          runAttempt,
        }),
      ).toBe(false);
    }
    expect(workflow.jobs.seal_release_child_evidence.needs).toContain("ci-gate");
    expect(workflow.jobs.seal_release_child_evidence.if).not.toContain("readiness");
  });
  it.each(["opened", "synchronize", "converted_to_draft", "labeled"])(
    "a delayed draft %s cannot publish a required result",
    (action) => {
      const context = {
        eventName: "pull_request" as const,
        repository,
        runAttempt: 1,
        draft: true,
        action,
      };
      expect(evaluateWorkflowExpression(workflow.jobs["ci-gate"].name, context)).not.toBe(
        "openclaw/ci-gate",
      );
      for (const id of ["readiness", "security-fast", "ci-gate"]) {
        const condition: string = workflow.jobs[id].if;
        expect(
          evaluateWorkflowExpression(
            condition.startsWith("${{") ? condition : `\${{ ${condition} }}`,
            context,
          ),
          id,
        ).toBe(false);
      }
    },
  );
  it.each(["partial", "failed-jobs"])(
    "%s rerun cannot reuse successful attempt-one admission before any expensive entry",
    () => {
      const context = {
        eventName: "pull_request" as const,
        repository,
        runAttempt: 2,
        readinessEnforced: true,
        readinessAttempt: 1,
        readinessBroadCi: true,
      };
      expect(evaluateWorkflowExpression(workflow.jobs.preflight.if, context)).toBe(false);
      for (const [id, value] of broadJobs) {
        const job = value as { if: string };
        const selected = Object.fromEntries(
          [...job.if.matchAll(/outputs\.([\w_]+)/g)].map((match) => [match[1], "true"]),
        );
        expect(
          evaluateWorkflowExpression(job.if, {
            ...context,
            sha: head,
            additionalNeeds: {
              "check-plan": { outputs: { check_matrix: "fixture-matrix" }, result: "success" },
              "build-artifacts": {
                outputs: { published_driver_artifact_id: "123" },
                result: "success",
              },
              "check-extension-package-boundary": { outputs: {}, result: "success" },
            },
            preflightOutputs: {
              ...selected,
              checkout_revision: head,
              runner_profile: "hybrid",
              frozen_target: "false",
              compatibility_target: "false",
              validation_tier: "full",
              release_scope: "full",
              readiness_enforced: "true",
              readiness_attempt: "1",
            },
          }),
          id,
        ).toBe(false);
      }
    },
  );
  it.each([
    "check-plan",
    "check-shard",
    "check-extension-package-boundary",
    "published-driver-update",
    "android-screenshots",
  ])("%s requires fresh readiness even after successful planning dependencies", (id) => {
    for (const admission of [1, 2]) {
      expect(
        evaluateWorkflowExpression(workflow.jobs[id].if, {
          eventName: "pull_request",
          repository,
          runAttempt: 2,
          sha: head,
          additionalNeeds: {
            "check-plan": { outputs: { check_matrix: "fixture-matrix" }, result: "success" },
            "build-artifacts": {
              outputs: { published_driver_artifact_id: "123" },
              result: "success",
            },
          },
          preflightOutputs: {
            run_check_plan: "true",
            run_check: "true",
            shared_sdk_declarations: "true",
            run_published_driver_update: "true",
            run_android_screenshots: "true",
            validation_tier: "full",
            release_scope: "full",
            compatibility_target: "false",
            checkout_revision: head,
            readiness_enforced: "true",
            readiness_attempt: String(admission),
          },
        }),
      ).toBe(admission === 2);
    }
  });
  it("keeps ordinary off-policy reruns and fresh full reruns runnable", () => {
    for (const readinessEnforced of [false, true]) {
      const context = {
        eventName: "pull_request" as const,
        repository,
        runAttempt: 2,
        readinessEnforced,
        readinessAttempt: readinessEnforced ? 2 : 1,
        readinessBroadCi: true,
      };
      expect(evaluateWorkflowExpression(workflow.jobs.preflight.if, context)).toBe(true);
      expect(
        evaluateWorkflowExpression(workflow.jobs["build-artifacts"].if, {
          ...context,
          preflightOutputs: {
            run_build_artifacts: "true",
            readiness_enforced: String(readinessEnforced),
            readiness_attempt: readinessEnforced ? "2" : "1",
          },
        }),
      ).toBe(true);
    }
  });
  it
    .skipIf(process.platform === "win32")
    .each(["current", "head", "label", "authority", "rerun-actor"])(
    "full rerun executes the real trusted readiness step before planning: %s",
    (change) => {
      const directory = tempDirs.make("readiness-rerun-");
      mkdirSync(join(directory, ".github"));
      const policy = { version: 1, mode: "all", pullRequests: [] };
      const pr = {
        number: 42,
        state: "open",
        draft: false,
        merge_commit_sha: tested,
        head: { sha: head, ref: "topic", repo: { full_name: repository } },
        base: { sha: base, ref: "main", repo: { full_name: repository } },
        labels: [] as { name: string }[],
      };
      const label = readinessLabel(pr, policy);
      pr.labels = [{ name: label }];
      const event = {
        action: "labeled",
        label: { name: label },
        sender: { login: "maintainer", id: 7 },
        pull_request: structuredClone(pr),
      };
      if (change === "head") {
        pr.head.sha = "d".repeat(40);
      }
      if (change === "label") {
        pr.labels = [];
      }
      writeFileSync(join(directory, ".github/ci-readiness.json"), JSON.stringify(policy));
      writeFileSync(join(directory, "event.json"), JSON.stringify(event));
      const cli = join(directory, "gh-fixture");
      writeFileSync(
        cli,
        `#!${process.execPath}
const route = process.argv[5];
const value = route.includes('/events?') ? [{id:101,event:'labeled',actor:{login:'maintainer',id:7},label:{name:${JSON.stringify(label)}}}] : route.endsWith('/permission') ? {permission: ${JSON.stringify(change === "authority" ? "read" : "write")},user:{id:7}} : ${JSON.stringify(pr)};
if (${JSON.stringify(change)} === 'rerun-actor' && route.includes('/rerunner/')) value.permission = 'read';
console.log(JSON.stringify(value));
`,
      );
      chmodSync(cli, 0o700);
      const step = workflow.jobs.readiness.steps.find(
        (item: { id?: string }) => item.id === "readiness",
      );
      const command = step.run.replace(
        "node scripts/ci-readiness.mjs",
        `node '${resolve("scripts/ci-readiness.mjs")}'`,
      );
      const result = spawnSync("bash", ["-c", command], {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_GH_BIN: cli,
          GH_TOKEN: "synthetic",
          GITHUB_REPOSITORY: repository,
          GITHUB_EVENT_PATH: join(directory, "event.json"),
          GITHUB_SHA: tested,
          GITHUB_RUN_ATTEMPT: "2",
          GITHUB_TRIGGERING_ACTOR: "rerunner",
          GITHUB_OUTPUT: join(directory, "output"),
          GITHUB_STEP_SUMMARY: join(directory, "summary"),
        },
      });
      expect(result.status, result.stdout + result.stderr).toBe(change === "current" ? 0 : 1);
      const outputs = Object.fromEntries(
        readFileSync(join(directory, "output"), "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split("=")),
      );
      expect(outputs.attempt).toBe("2");
      expect(
        evaluateWorkflowExpression(workflow.jobs.preflight.if, {
          eventName: "pull_request",
          repository,
          runAttempt: 2,
          readinessResult: result.status === 0 ? "success" : "failure",
          readinessBroadCi: outputs.broad_ci === "true",
          readinessEnforced: true,
          readinessAttempt: Number(outputs.attempt),
        }),
      ).toBe(change === "current");
    },
  );
});
