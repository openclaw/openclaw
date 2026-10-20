import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ignore from "ignore";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { pnpmLockfileDocuments } from "../../scripts/lib/pnpm-lockfile-documents.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

type WorkflowStep = {
  name?: string;
  "continue-on-error"?: boolean;
  "timeout-minutes"?: number;
  env?: Record<string, string>;
  if?: string;
  id?: string;
  run?: string;
  shell?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type Workflow = {
  on: Record<string, { types?: string[]; workflows?: string[] }>;
  permissions: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress": boolean };
  jobs: Record<
    string,
    {
      if?: string;
      needs?: string | string[];
      outputs?: Record<string, string>;
      permissions?: Record<string, string>;
      env?: Record<string, string>;
      concurrency?: { group: string; "cancel-in-progress": boolean };
      strategy?: { "fail-fast": boolean; matrix: string };
      steps: WorkflowStep[];
    }
  >;
};

const workflow = parse(readFileSync(".github/workflows/security-review.yml", "utf8")) as Workflow;

function evaluate(expression: string, context: Record<string, unknown>) {
  return runInNewContext(expression.replace(/^\$\{\{|\}\}$/gu, ""), context);
}

function checkCondition(expression: string) {
  return (context: Record<string, unknown>, allowed: boolean) => {
    expect(Boolean(evaluate(expression, context))).toBe(allowed);
  };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function stepsUsing(steps: WorkflowStep[], action: string) {
  return steps.filter((step) => step.uses?.startsWith(`${action}@`));
}
const runtimeActionPath = ".github/actions/setup-security-review";
const runtimeAction = parse(readFileSync(`${runtimeActionPath}/action.yml`, "utf8")) as {
  runs: { using: string; steps: WorkflowStep[] };
};
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function materializeJobSources(
  workspace: string,
  name: "resolve" | "review",
  checkoutId = "checkout",
) {
  const checkout = workflow.jobs[name]!.steps.find((step) => step.id === checkoutId);
  const sparse = checkout?.with?.["sparse-checkout"];
  const checkoutPath = checkout?.with?.path;
  if (typeof sparse !== "string" || typeof checkoutPath !== "string") {
    throw new Error(`Missing ${name} sparse checkout selection`);
  }
  const source = join(workspace, checkoutPath);
  for (const pattern of sparse.trim().split(/\s+/u)) {
    expect(pattern).toMatch(/^\/[^*?[\]!]+$/u);
    const relativePath = pattern.slice(1);
    expect(relativePath.split("/")).not.toContain("..");
    const destination = join(source, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(resolve(relativePath), destination, { recursive: true });
  }
  return source;
}

function stageJobSources(workspace: string, name: "resolve" | "review", recovered = false) {
  const stage = workflow.jobs[name]!.steps.find((step) => step.id === "sources");
  expect(stage).toBeDefined();
  const env = Object.fromEntries(
    Object.entries(stage!.env ?? {}).map(([key, expression]) => [
      key,
      String(
        evaluate(expression, {
          steps: { checkout: { outcome: recovered ? "failure" : "success" } },
        }),
      ),
    ]),
  );
  execFileSync("bash", ["-e", "-c", stage!.run!], {
    cwd: workspace,
    env: { PATH: process.env.PATH, ...env },
  });
}

function runSelectedEntry(workspace: string, entry: string) {
  return spawnSync(process.execPath, [join(workspace, "scripts/github", entry)], {
    cwd: workspace,
    env: {},
    encoding: "utf8",
  });
}

describe("security review workflow trust boundaries", () => {
  it.each([
    { name: "resolve", recovered: false },
    { name: "resolve", recovered: true },
    { name: "review", recovered: true },
  ] as const)("stages trusted $name sources (recovered=$recovered)", ({ name, recovered }) => {
    const workspace = tempDirs.make("openclaw-security-checkout-retry-");
    const failedSource = materializeJobSources(workspace, name);
    if (recovered) {
      mkdirSync(join(failedSource, ".git"), { recursive: true });
      writeFileSync(join(failedSource, ".git/index.lock"), "failed checkout lock");
      materializeJobSources(workspace, name, "checkout_retry");
      // A timed-out checkout must not change the scripts selected by recovery.
      writeFileSync(
        join(failedSource, "scripts/github/guard-shared.mjs"),
        'throw new Error("late write from failed checkout");',
      );
    }
    stageJobSources(workspace, name, recovered);
    if (name === "resolve") {
      const result = runSelectedEntry(workspace, "security-review-event.mjs");
      expect({ status: result.status, stderr: result.stderr.trim() }).toEqual({
        status: 1,
        stderr: "GitHub token, event, event name, and repository are required.",
      });
    }
    const probe = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", 'import "./scripts/github/guard-shared.mjs"'],
      { cwd: workspace, env: {}, encoding: "utf8" },
    );
    expect(probe).toMatchObject({ stderr: "", status: 0 });
    expect(existsSync(join(workspace, ".git/index.lock"))).toBe(false);
    if (name === "review") {
      expect(readFileSync(join(workspace, runtimeActionPath, "action.yml"), "utf8")).toBe(
        readFileSync(`${runtimeActionPath}/action.yml`, "utf8"),
      );
    }
  });

  it("executes trusted scripts and limits comment writes to the serialized review job", () => {
    expect(workflow.permissions).toEqual({
      contents: "read",
      "pull-requests": "read",
      actions: "read",
      statuses: "write",
    });
    expect(workflow.jobs.review?.permissions).toEqual({
      contents: "read",
      "pull-requests": "write",
      actions: "read",
      issues: "write",
      statuses: "write",
    });
    expect(workflow.concurrency).toBeUndefined();
    const { concurrency, strategy, env } = workflow.jobs.review!;
    expect({ concurrency, strategy, env }).toEqual({
      concurrency: { group: "security-review-${{ matrix.head }}", "cancel-in-progress": false },
      strategy: { "fail-fast": false, matrix: "${{ fromJSON(needs.resolve.outputs.matrix) }}" },
      env: {
        OPENCLAW_SECURITY_REVIEW_PR_NUMBER: "${{ matrix.pr }}",
        OPENCLAW_SECURITY_REVIEW_HEAD_SHA: "${{ matrix.head }}",
      },
    });
    for (const name of ["resolve", "review"]) {
      const job = workflow.jobs[name]!;
      const checkouts = stepsUsing(job.steps, "actions/checkout");
      expect(checkouts).toHaveLength(2);
      expect(checkouts[1]?.with).toEqual({
        ...checkouts[0]?.with,
        path: "security-review-retry",
      });
      expect(checkouts[1]).toMatchObject({ uses: checkouts[0]?.uses, "timeout-minutes": 5 });
      expect(checkouts[0]?.["timeout-minutes"]).toBe(5);
      expect(checkouts[0]?.with).toMatchObject({
        path: "security-review-primary",
        "persist-credentials": false,
      });
      for (const input of ["ref", "repository", "allow-unsafe-pr-checkout"]) {
        expect(checkouts[0]?.with).not.toHaveProperty(input);
      }
      const runtime = job.steps.filter((step) => step.uses === `./${runtimeActionPath}`);
      expect(runtime).toHaveLength(name === "review" ? 1 : 0);
      if (runtime.length > 0) {
        expect(runtime[0]?.["timeout-minutes"]).toBe(3);
      }
      const bootstrap = stepsUsing(job.steps, "actions/setup-node");
      expect(bootstrap).toEqual(
        name === "resolve"
          ? [
              {
                name: "Setup supported Node runtime",
                "timeout-minutes": 3,
                uses: "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
                with: { "node-version": "24.21.0", "package-manager-cache": false },
              },
            ]
          : [],
      );
      if (name === "resolve") {
        const bootstrapIndex = job.steps.findIndex((step) => step === bootstrap[0]);
        expect(bootstrapIndex).toBeGreaterThan(
          job.steps.findIndex((step) => step === checkouts[0]),
        );
        expect(bootstrapIndex).toBeLessThan(
          job.steps.findIndex((step) => step.run?.startsWith("node ")),
        );
      }
      for (const step of job.steps) {
        if (step.uses && step.uses !== `./${runtimeActionPath}` && step !== bootstrap[0]) {
          expect(step.uses).toMatch(
            /^actions\/(?:checkout|create-github-app-token|github-script)@[a-f0-9]{40}$/u,
          );
        }
        if (step.run) {
          if (step.id === "sources") {
            continue;
          }
          if (step.name === "Report checkout infrastructure retry") {
            expect(step.if).toBe("${{ !cancelled() && steps.checkout.outcome == 'failure' }}");
            expect(step.run).toBe(
              'echo "::warning::Trusted workflow checkout failed; retrying GitHub source transport once."',
            );
            continue;
          }
          // Final enforcement is exercised with preparation outputs below.
          if (step.env?.OPENCLAW_SECURITY_REVIEW_MODE !== "enforce") {
            expect(step.run).toBe(
              `node scripts/github/security-review${name === "resolve" ? "-event" : ""}.mjs`,
            );
          }
          expect(step.env?.GITHUB_TOKEN).toBe("${{ github.token }}");
        }
      }
    }
    expect(existsSync(".github/workflows/security-sensitive-guard.yml")).toBe(false);
    expect(existsSync(".github/workflows/dependency-guard.yml")).toBe(false);
  });

  it.each([
    { failures: 0, attempts: 1, jobFailed: false, cancelled: false },
    { failures: 1, attempts: 2, jobFailed: false, cancelled: false },
    { failures: 2, attempts: 2, jobFailed: true, cancelled: false },
    { failures: 1, attempts: 1, jobFailed: false, cancelled: true },
  ])(
    "bounds checkout recovery ($failures failures, cancelled=$cancelled)",
    ({ failures, attempts, jobFailed, cancelled }) => {
      for (const name of ["resolve", "review"]) {
        const job = workflow.jobs[name]!;
        const steps: Record<string, { outcome: string }> = {};
        let failed = false;
        let executed = 0;
        for (const step of stepsUsing(job.steps, "actions/checkout")) {
          const allowed: boolean = step.if
            ? Boolean(
                evaluate(step.if, {
                  steps,
                  cancelled: () => cancelled,
                }),
              )
            : !failed;
          const outcome: "skipped" | "failure" | "success" = !allowed
            ? "skipped"
            : ++executed <= failures
              ? "failure"
              : "success";
          if (step.id) {
            steps[step.id] = { outcome };
          }
          failed ||= outcome === "failure" && step["continue-on-error"] !== true;
        }
        expect({ executed, failed }).toEqual({ executed: attempts, failed: jobFailed });
      }
    },
  );

  it.each([
    { state: "open", sameHead: true, publish: true },
    { state: "closed", sameHead: true, publish: false },
    { state: "open", sameHead: false, publish: false },
  ])(
    "reports bootstrap failure only for the current open head ($state, sameHead=$sameHead)",
    async ({ state, sameHead, publish }) => {
      const [reporter] = stepsUsing(workflow.jobs.review!.steps, "actions/github-script");
      expect(reporter).toBeDefined();
      const sha = "a".repeat(40);
      const writes: unknown[] = [];
      await runInNewContext(`(async () => { ${String(reporter!.with!.script)} })()`, {
        process: {
          env: { OPENCLAW_SECURITY_REVIEW_PR_NUMBER: "42", OPENCLAW_SECURITY_REVIEW_HEAD_SHA: sha },
        },
        context: {
          repo: { owner: "example", repo: "project" },
          runId: 123,
          serverUrl: "https://github.com",
        },
        core: { info: () => {} },
        github: {
          rest: {
            pulls: {
              get: async () => ({
                data: { state, head: { sha: sameHead ? sha : "b".repeat(40) } },
              }),
            },
            repos: {
              createCommitStatus: async (status: unknown) => {
                writes.push(status);
              },
            },
          },
        },
      });
      expect(writes).toEqual(
        publish
          ? [
              {
                owner: "example",
                repo: "project",
                sha,
                context: "openclaw/ci-gate",
                state: "failure",
                description: "PR #42: Security review setup failed; see workflow details",
                target_url: "https://github.com/example/project/actions/runs/123",
              },
            ]
          : [],
      );
      const check = checkCondition(reporter!.if!);
      for (const [failed, runtime, cancelled, allowed] of [
        [true, "failure", false, true],
        [true, "skipped", false, true],
        [false, "success", false, false],
        [true, "success", false, false],
        [true, "skipped", true, false],
      ] as const) {
        check(
          {
            steps: { runtime: { outcome: runtime } },
            failure: () => failed,
            cancelled: () => cancelled,
          },
          allowed,
        );
      }
    },
  );

  it("uses PR, command, revocation, CI completion, and reconciliation events", () => {
    expect(Object.keys(workflow.on).toSorted()).toEqual([
      "issue_comment",
      "pull_request_target",
      "schedule",
      "workflow_run",
    ]);
    expect(workflow.on).toEqual({
      pull_request_target: {
        types: expect.arrayContaining([
          "opened",
          "reopened",
          "synchronize",
          "ready_for_review",
          "edited",
          "closed",
        ]),
      },
      issue_comment: { types: ["created", "edited", "deleted"] },
      workflow_run: { workflows: ["CI"], types: ["completed"] },
      schedule: [{ cron: "4-59/10 * * * *" }],
    });
    const concurrency = workflow.jobs.resolve!.concurrency!;
    expect(concurrency["cancel-in-progress"]).toBe(false);
    for (const eventName of Object.keys(workflow.on)) {
      for (const runId of [123, 456]) {
        expect(
          evaluate(concurrency.group, {
            github: { event_name: eventName, run_id: runId },
            format: (template: string, value: number) => template.replace("{0}", String(value)),
          }),
        ).toBe(
          eventName === "schedule"
            ? "security-review-reconcile"
            : `security-review-resolve-${runId}`,
        );
      }
    }
    const pr = (allowed: boolean, action?: string, changes = {}) => ({
      allowed,
      eventName: "pull_request_target",
      event: { action, changes },
    });
    const ci = (allowed: boolean, event: string) => ({
      allowed,
      eventName: "workflow_run",
      event: { workflow_run: { event } },
    });
    const comment = (allowed: boolean, action: string, body = "", from = "", issue = false) => ({
      allowed,
      eventName: "issue_comment",
      event: {
        action,
        comment: { body },
        changes: { body: { from } },
        issue: { pull_request: issue ? null : {} },
      },
    });
    for (const { allowed, eventName, event } of [
      pr(true),
      pr(true, "synchronize"),
      pr(true, "closed"),
      pr(false, "edited", { title: { from: "Previous title" } }),
      pr(false, "edited", { body: { from: "Previous body" } }),
      pr(true, "edited", { body: { from: "" }, base: { ref: { from: "release" } } }),
      pr(true, "edited", { maintainer_can_modify: { from: false } }),
      pr(true, "edited"),
      { allowed: true, eventName: "schedule", event: {} },
      ci(true, "pull_request"),
      ci(false, "push"),
      ci(true, "workflow_dispatch"),
      comment(true, "created", "/allow-security-sensitive-change"),
      comment(true, "created", "/allow-dependencies-change"),
      comment(false, "created", "Thanks"),
      comment(true, "edited", "Command removed", "/allow-dependencies-change"),
      comment(true, "edited", "/allow-security-sensitive-change", "Thanks"),
      comment(true, "deleted", "/allow-dependencies-change"),
      comment(false, "edited", "Thanks again", "Thanks"),
      comment(false, "deleted", "Thanks"),
      comment(false, "created", "/allow-dependencies-change", "", true),
      comment(false, "edited", "", "", true),
    ]) {
      const result = evaluate(workflow.jobs.resolve!.if!, {
        github: {
          event_name: eventName,
          event,
        },
        contains: (value: string, search: string) =>
          value.toLowerCase().includes(search.toLowerCase()),
      });
      expect(Boolean(result), JSON.stringify({ eventName, event })).toBe(allowed);
    }
  });

  it("fails a truncated reconciliation after the selected reviews finish", () => {
    expect(workflow.jobs.resolve!.outputs?.truncated).toBe("${{ steps.event.outputs.truncated }}");
    const backlog = workflow.jobs["reconcile-backlog"]!;
    expect(backlog.needs).toEqual(["resolve", "review"]);
    expect(backlog.if).toBe("${{ always() && needs.resolve.outputs.truncated == 'true' }}");
    expect(backlog.permissions).toEqual({});
    for (const truncated of ["true", "false", undefined]) {
      expect(
        evaluate(backlog.if!, {
          always: () => true,
          needs: { resolve: { outputs: { truncated } } },
        }),
      ).toBe(truncated === "true");
    }
    const result = spawnSync("bash", ["-e", "-c", backlog.steps[0]!.run!], {
      env: {},
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain("next scheduled pass continues from the same window");
  });

  it("limits autoscrub writes to PR events and always enforces after failures", () => {
    const steps = workflow.jobs.review!.steps;
    const commands = steps.filter((step) => step.env?.OPENCLAW_SECURITY_REVIEW_MODE);
    expect(commands.map((step) => step.env?.OPENCLAW_SECURITY_REVIEW_MODE)).toEqual([
      "prepare",
      "autoscrub",
      "enforce",
    ]);
    expect(commands[0]?.if).toBe(
      "github.event_name == 'pull_request_target' && github.event.action != 'closed' && matrix.pr == github.event.pull_request.number",
    );
    const checkPrepare = checkCondition(commands[0]!.if!);
    for (const [eventName, action, target, allowed] of [
      ["pull_request_target", "synchronize", 42, true],
      ["pull_request_target", "synchronize", 43, false],
      ["pull_request_target", "closed", 42, false],
      ["issue_comment", "created", 42, false],
    ] as const) {
      checkPrepare(
        {
          github: { event_name: eventName, event: { action, pull_request: { number: 42 } } },
          matrix: { pr: target },
        },
        allowed,
      );
    }
    expect(commands[1]?.if).toBe(
      "github.event_name == 'pull_request_target' && github.event.action != 'closed' && matrix.pr == github.event.pull_request.number && steps.detect.outputs.autoscrub == 'true'",
    );
    const checkEnforce = checkCondition(commands[2]!.if!);
    for (const [runtime, cancelled, allowed] of [
      ["success", false, true],
      ["failure", false, false],
      ["skipped", false, false],
      ["success", true, false],
    ] as const) {
      checkEnforce(
        {
          steps: { runtime: { outcome: runtime } },
          cancelled: () => cancelled,
        },
        allowed,
      );
    }
    const tokenSteps = stepsUsing(steps, "actions/create-github-app-token");
    expect(tokenSteps.map((step) => step.with?.["app-id"])).toEqual(["2729701", "2971289"]);
    for (const step of tokenSteps) {
      expect(step["continue-on-error"]).toBe(true);
      expect(step.if).toContain("github.event_name == 'pull_request_target'");
      expect(step.if).toContain("github.event.action != 'closed'");
      expect(step.if).toContain("matrix.pr == github.event.pull_request.number");
      expect(step.if).toContain("steps.detect.outputs.autoscrub == 'true'");
      expect(step.with).toMatchObject({
        owner: "${{ steps.detect.outputs.autoscrub-owner }}",
        repositories: "${{ steps.detect.outputs.autoscrub-repository }}",
        "permission-contents": "write",
      });
      expect(Object.keys(step.with!).filter((key) => key.startsWith("permission-"))).toEqual([
        "permission-contents",
      ]);
    }
    expect(tokenSteps[1]?.if).toContain("steps.app-token.outcome == 'failure'");
    expect(commands[1]?.env?.OPENCLAW_DEPENDENCY_GUARD_AUTOSCRUB_TOKEN).toBe(
      "${{ steps.app-token.outputs.token || steps.app-token-fallback.outputs.token }}",
    );
    expect(commands[2]?.env).not.toHaveProperty("OPENCLAW_DEPENDENCY_GUARD_AUTOSCRUB_TOKEN");
    for (const completed of ["true", "false", ""]) {
      const command = commands[2]!.run!.replace("${{ steps.detect.outputs.completed }}", completed);
      const result = spawnSync("bash", ["-e", "-c", `node() { echo enforced; }\n${command}`], {
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(
        completed === "true" ? "Security review completed during preparation." : "enforced",
      );
    }
  });

  it("uses an explicit Node runtime without shared dependency caches or bootstrap credentials", () => {
    expect(runtimeAction.runs.using).toBe("composite");
    const setup = runtimeAction.runs.steps.filter((step) => step.uses);
    expect(setup).toHaveLength(1);
    expect(setup[0]?.uses).toMatch(/^actions\/setup-node@[a-f0-9]{40}$/u);
    expect(setup[0]?.with).toEqual({ "node-version": "24.x", "package-manager-cache": false });
    for (const step of runtimeAction.runs.steps) {
      expect(step.env).toBeUndefined();
      expect(JSON.stringify(step)).not.toMatch(/github\.token|secrets\.|github\.event/u);
    }
  });

  it.skipIf(process.platform === "win32")(
    "installs only the frozen trusted tooling project and makes its policy packages importable",
    () => {
      const root = tempDirs.make("openclaw-security-review-runtime-");
      const workspace = join(root, "workspace");
      const runnerTemp = join(root, "runner");
      const bin = join(root, "bin");
      for (const directory of [workspace, runnerTemp, bin]) {
        mkdirSync(directory, { recursive: true });
      }
      materializeJobSources(workspace, "review");
      stageJobSources(workspace, "review");
      const selectedRuntimePath = join(workspace, runtimeActionPath);
      const selectedRuntime = parse(
        readFileSync(join(selectedRuntimePath, "action.yml"), "utf8"),
      ) as {
        runs: { steps: WorkflowStep[] };
      };
      const installLog = join(root, "install.json");
      const packages = Object.fromEntries(
        ["yaml", "minimatch"].map((name) => [name, realpathSync(`node_modules/${name}`)]),
      );
      // The external installer is replaced; the composite's shell and Node's ESM
      // resolution run unchanged against the repository's real installed packages.
      writeFileSync(
        join(bin, "npm"),
        `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(${JSON.stringify(installLog)}, JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  manifest: JSON.parse(fs.readFileSync("package.json", "utf8")),
  lock: JSON.parse(fs.readFileSync("package-lock.json", "utf8")),
}));
fs.mkdirSync("node_modules");
for (const [name, target] of Object.entries(${JSON.stringify(packages)})) {
  fs.symlinkSync(target, path.join("node_modules", name), "dir");
}
`,
        { mode: 0o700 },
      );
      const installSteps = selectedRuntime.runs.steps.filter((step) => step.run);
      expect(installSteps).toHaveLength(1);
      expect(installSteps[0]?.shell).toBe("bash");
      execFileSync("bash", ["-c", installSteps[0]!.run!], {
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          GITHUB_ACTION_PATH: selectedRuntimePath,
          GITHUB_WORKSPACE: workspace,
          RUNNER_TEMP: runnerTemp,
        },
      });
      const installed = readJson<{
        args: string[];
        cwd: string;
        manifest: unknown;
        lock: unknown;
      }>(installLog);
      expect(installed.args).toEqual(["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
      expect(installed.cwd.startsWith(`${realpathSync(runnerTemp)}/`)).toBe(true);
      expect(installed.manifest).toEqual(readJson(`${runtimeActionPath}/package.json`));
      expect(installed.lock).toEqual(readJson(`${runtimeActionPath}/package-lock.json`));
      const probe = join(workspace, "scripts/github/probe.mjs");
      writeFileSync(
        probe,
        'import { parse } from "yaml"; import { minimatch } from "minimatch"; import { loadSecurityReviewPolicy } from "./security-review-policy.mjs"; console.log(JSON.stringify([parse("category: secrets").category, minimatch("src/secrets/.store/key", "src/secrets/**", { dot: true }), loadSecurityReviewPolicy().isDependencyManifest("package.json")]));',
      );
      expect(
        JSON.parse(execFileSync(process.execPath, [probe], { env: {}, encoding: "utf8" })),
      ).toEqual(["secrets", true, true]);
      const loaded = runSelectedEntry(workspace, "security-review.mjs");
      expect(loaded.status).toBe(1);
      expect(loaded.stderr.trim()).toBe(
        "GITHUB_TOKEN, GITHUB_EVENT_PATH, and GITHUB_REPOSITORY are required.",
      );
    },
  );

  it("keeps the frozen runtime dependency closure on the canonical repository pins and integrity", () => {
    const manifest = readJson<{
      dependencies: Record<string, string>;
      overrides: Record<string, string>;
    }>(`${runtimeActionPath}/package.json`);
    const root = readJson<{
      dependencies: Record<string, string>;
    }>("package.json");
    const workspace = parse(readFileSync("pnpm-workspace.yaml", "utf8")) as {
      overrides: Record<string, string>;
    };
    const canonical = parse(
      pnpmLockfileDocuments(readFileSync("pnpm-lock.yaml", "utf8")).dependencies,
    ) as {
      packages: Record<string, { resolution: { integrity: string } }>;
      snapshots: Record<string, { dependencies?: Record<string, string> }>;
    };
    const lock = readJson<{
      packages: Record<string, { version: string; integrity: string }>;
    }>(`${runtimeActionPath}/package-lock.json`);
    expect(manifest.dependencies).toEqual({
      yaml: root.dependencies.yaml,
      minimatch: root.dependencies.minimatch,
    });
    expect(lock.packages[""]?.dependencies).toEqual(manifest.dependencies);
    for (const [name, version] of Object.entries(manifest.overrides)) {
      expect(version).toBe(workspace.overrides[name]);
    }
    const pending = Object.entries(manifest.dependencies);
    const expectedPackages = new Set([""]);
    for (const [name, version] of pending) {
      const key = `${name}@${version}`;
      const path = `node_modules/${name}`;
      expectedPackages.add(path);
      expect(lock.packages[path]).toMatchObject({
        version,
        integrity: canonical.packages[key]?.resolution.integrity,
      });
      for (const dependency of Object.entries(canonical.snapshots[key]?.dependencies ?? {})) {
        if (!expectedPackages.has(`node_modules/${dependency[0]}`)) {
          pending.push(dependency);
        }
      }
    }
    expect(Object.keys(lock.packages).toSorted()).toEqual([...expectedPackages].toSorted());
  });
});

const ownerRules = readFileSync(".github/CODEOWNERS", "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))
  .map((line) => {
    const [pattern, ...owners] = line.split(/\s+/u);
    return { matches: ignore({ ignorecase: false }).add(pattern ?? ""), owners };
  });

function ownersFor(path: string) {
  // CODEOWNERS uses gitignore-style patterns with last matching ownership winning.
  return ownerRules.findLast((rule) => rule.matches.ignores(path))?.owners ?? [];
}

describe("security review ownership", () => {
  it.each([
    ...[
      ".github/CODEOWNERS",
      "SECURITY.md",
      ".github/codeql/openclaw-boundary/queries/managed-proxy-runtime-mutation.ql",
      ".github/workflows/codeql-macos-critical-security.yml",
      ".github/workflows/security-review.yml",
      ".github/security-review-policy.yml",
      ".github/actions/setup-security-review/action.yml",
      "scripts/github/security-review-policy.mjs",
      "scripts/github/security-review-event.mjs",
      "scripts/github/security-review.mjs",
      "scripts/github/security-review-rollout.mjs",
      "scripts/github/guard-review.mjs",
      "scripts/github/guard-shared.mjs",
      "scripts/lib/bounded-response.mjs",
    ].map((path) => ({ path, owners: ["@openclaw/openclaw-secops"] })),
    ...[
      "src/gateway/auth.ts",
      "src/secrets/store/secret-store.ts",
      "src/agents/sandbox.ts",
      "pnpm-lock.yaml",
      ".gitignore",
      "docs/gateway/secrets.md",
    ].map((path) => ({ path, owners: [] })),
    {
      path: ".github/workflows/openclaw-npm-release.yml",
      owners: ["@openclaw/openclaw-release-managers"],
    },
  ])("keeps the designated review authority for $path", ({ path, owners }) => {
    expect(ownersFor(path)).toEqual(owners);
  });
});
