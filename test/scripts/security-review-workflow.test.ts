import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  name: string;
  on: Record<string, { types?: string[]; workflows?: string[]; inputs?: Record<string, unknown> }>;
  permissions: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress": boolean };
  jobs: Record<
    string,
    {
      if?: string;
      permissions?: Record<string, string>;
      env?: Record<string, string>;
      concurrency?: { group: string; "cancel-in-progress": boolean };
      strategy?: { "fail-fast": boolean; matrix: string };
      steps: WorkflowStep[];
    }
  >;
};

function readWorkflow(name: string): Workflow {
  return parse(readFileSync(`.github/workflows/${name}.yml`, "utf8")) as Workflow;
}

const reviewPermissions = {
  contents: "read",
  "pull-requests": "write",
  actions: "read",
  issues: "write",
  statuses: "write",
};
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
  const checkout = readWorkflow("security-review").jobs[name]!.steps.find(
    (step) => step.id === checkoutId,
  );
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
  const stage = readWorkflow("security-review").jobs[name]!.steps.find(
    (step) => step.id === "sources",
  );
  expect(stage).toBeDefined();
  const env = Object.fromEntries(
    Object.entries(stage!.env ?? {}).map(([key, expression]) => [
      key,
      String(
        runInNewContext(expression.replace(/^\$\{\{|\}\}$/gu, ""), {
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
  it.each(["resolve", "review"] as const)(
    "isolates %s recovery from late writes in the failed checkout",
    (name) => {
      const workspace = tempDirs.make("openclaw-security-checkout-retry-");
      const failedSource = materializeJobSources(workspace, name);
      mkdirSync(join(failedSource, ".git"), { recursive: true });
      writeFileSync(join(failedSource, ".git/index.lock"), "failed checkout lock");
      materializeJobSources(workspace, name, "checkout_retry");
      // A timed-out checkout must not change the scripts selected by recovery.
      writeFileSync(
        join(failedSource, "scripts/github/guard-shared.mjs"),
        'throw new Error("late write from failed checkout");',
      );
      stageJobSources(workspace, name, true);
      const probe = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", 'import "./scripts/github/guard-shared.mjs"'],
        { cwd: workspace, env: {}, encoding: "utf8" },
      );
      expect(probe.stderr).toBe("");
      expect(probe.status).toBe(0);
      expect(existsSync(join(workspace, ".git/index.lock"))).toBe(false);
      if (name === "review") {
        expect(readFileSync(join(workspace, runtimeActionPath, "action.yml"), "utf8")).toBe(
          readFileSync(`${runtimeActionPath}/action.yml`, "utf8"),
        );
      }
    },
  );

  it("executes trusted scripts and limits comment writes to the serialized review job", () => {
    const workflow = readWorkflow("security-review");
    expect(workflow.permissions).toEqual({
      contents: "read",
      "pull-requests": "read",
      actions: "read",
      statuses: "write",
    });
    expect(workflow.jobs.review?.permissions).toEqual(reviewPermissions);
    expect(workflow.concurrency).toBeUndefined();
    expect(workflow.jobs.review?.concurrency).toEqual({
      group: "security-review-${{ matrix.head }}",
      "cancel-in-progress": false,
    });
    expect(workflow.jobs.review?.strategy).toEqual({
      "fail-fast": false,
      matrix: "${{ fromJSON(needs.resolve.outputs.matrix) }}",
    });
    expect(workflow.jobs.review?.env).toEqual({
      OPENCLAW_SECURITY_REVIEW_PR_NUMBER: "${{ matrix.pr }}",
      OPENCLAW_SECURITY_REVIEW_HEAD_SHA: "${{ matrix.head }}",
    });
    for (const [name, job] of Object.entries(workflow.jobs)) {
      const checkouts = job.steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
      expect(checkouts).toHaveLength(2);
      expect(checkouts[1]?.with).toEqual({
        ...checkouts[0]?.with,
        path: "security-review-retry",
      });
      expect(checkouts[1]?.uses).toBe(checkouts[0]?.uses);
      expect(checkouts[1]?.["timeout-minutes"]).toBe(5);
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
      const bootstrap = job.steps.filter((step) => step.uses?.startsWith("actions/setup-node@"));
      expect(bootstrap).toEqual(
        name === "resolve"
          ? [
              {
                name: "Setup supported Node runtime",
                "timeout-minutes": 3,
                uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
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
          expect(step.run).toBe(
            `node scripts/github/security-review${name === "resolve" ? "-event" : ""}.mjs`,
          );
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
      for (const job of Object.values(readWorkflow("security-review").jobs)) {
        const steps: Record<string, { outcome: string }> = {};
        let failed = false;
        let executed = 0;
        for (const step of job.steps.filter((candidate) =>
          candidate.uses?.startsWith("actions/checkout@"),
        )) {
          const allowed: boolean = step.if
            ? Boolean(
                runInNewContext(step.if.replace(/^\$\{\{|\}\}$/gu, ""), {
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
        expect(executed).toBe(attempts);
        expect(failed).toBe(jobFailed);
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
      const reporter = readWorkflow("security-review").jobs.review!.steps.find((step) =>
        step.uses?.startsWith("actions/github-script@"),
      );
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
      for (const [failed, runtime, cancelled, allowed] of [
        [true, "failure", false, true],
        [true, "skipped", false, true],
        [false, "success", false, false],
        [true, "success", false, false],
        [true, "skipped", true, false],
      ] as const) {
        expect(
          Boolean(
            runInNewContext(reporter!.if!.replace(/^\$\{\{|\}\}$/gu, ""), {
              steps: { runtime: { outcome: runtime } },
              failure: () => failed,
              cancelled: () => cancelled,
            }),
          ),
        ).toBe(allowed);
      }
    },
  );

  it("uses automatic PR, command, revocation, and CI completion events only", () => {
    const workflow = readWorkflow("security-review");
    expect(Object.keys(workflow.on).toSorted()).toEqual([
      "issue_comment",
      "pull_request_target",
      "workflow_run",
    ]);
    expect(workflow.on.pull_request_target?.types).toEqual(
      expect.arrayContaining([
        "opened",
        "reopened",
        "synchronize",
        "ready_for_review",
        "edited",
        "closed",
      ]),
    );
    expect(workflow.on.issue_comment?.types).toEqual(["created", "edited", "deleted"]);
    expect(workflow.on.workflow_run).toEqual({ workflows: ["CI"], types: ["completed"] });
    const condition = workflow.jobs.resolve!.if!.replace(/^\$\{\{|\}\}$/gu, "");
    for (const event of [
      { eventName: "pull_request_target", allowed: true },
      { eventName: "pull_request_target", action: "synchronize", allowed: true },
      { eventName: "pull_request_target", action: "closed", allowed: true },
      {
        eventName: "pull_request_target",
        action: "edited",
        changes: { title: { from: "Previous title" } },
        allowed: false,
      },
      {
        eventName: "pull_request_target",
        action: "edited",
        changes: { body: { from: "Previous body" } },
        allowed: false,
      },
      {
        eventName: "pull_request_target",
        action: "edited",
        changes: { body: { from: "" }, base: { ref: { from: "release" } } },
        allowed: true,
      },
      {
        eventName: "pull_request_target",
        action: "edited",
        changes: { maintainer_can_modify: { from: false } },
        allowed: true,
      },
      { eventName: "pull_request_target", action: "edited", changes: {}, allowed: true },
      { eventName: "workflow_run", sourceEvent: "pull_request", allowed: true },
      { eventName: "workflow_run", sourceEvent: "push", allowed: false },
      { eventName: "workflow_run", sourceEvent: "workflow_dispatch", allowed: true },
      { action: "created", body: "/allow-security-sensitive-change", allowed: true },
      { action: "created", body: "/allow-dependencies-change", allowed: true },
      { action: "created", body: "Thanks", allowed: false },
      {
        action: "edited",
        body: "Command removed",
        previousBody: "/allow-dependencies-change",
        allowed: true,
      },
      {
        action: "edited",
        body: "/allow-security-sensitive-change",
        previousBody: "Thanks",
        allowed: true,
      },
      { action: "deleted", body: "/allow-dependencies-change", allowed: true },
      { action: "edited", body: "Thanks again", previousBody: "Thanks", allowed: false },
      { action: "deleted", body: "Thanks", allowed: false },
      { action: "created", body: "/allow-dependencies-change", issue: true, allowed: false },
      { action: "edited", issue: true, allowed: false },
    ]) {
      const result = runInNewContext(condition, {
        github: {
          event_name: event.eventName ?? "issue_comment",
          event: {
            action: event.action,
            comment: { body: event.body ?? "" },
            changes:
              event.changes ??
              (event.eventName === "pull_request_target"
                ? {}
                : { body: { from: event.previousBody ?? "" } }),
            issue: { pull_request: event.issue ? null : {} },
            workflow_run: { event: event.sourceEvent },
          },
        },
        contains: (value: string, search: string) =>
          value.toLowerCase().includes(search.toLowerCase()),
        startsWith: (value: unknown, prefix: string) => String(value).startsWith(prefix),
        vars: { OPENCLAW_RELEASE_PRIORITY_RUN: "" },
      });
      expect(Boolean(result), JSON.stringify(event)).toBe(event.allowed);
    }
  });

  it("limits autoscrub writes to PR events and always enforces after failures", () => {
    const steps = readWorkflow("security-review").jobs.review!.steps;
    const commands = steps.filter((step) => step.run?.startsWith("node "));
    expect(commands.map((step) => step.env?.OPENCLAW_SECURITY_REVIEW_MODE)).toEqual([
      "detect",
      "autoscrub",
      "enforce",
    ]);
    expect(commands[0]?.if).toBe(
      "github.event_name == 'pull_request_target' && github.event.action != 'closed' && matrix.pr == github.event.pull_request.number",
    );
    for (const [eventName, action, target, allowed] of [
      ["pull_request_target", "synchronize", 42, true],
      ["pull_request_target", "synchronize", 43, false],
      ["pull_request_target", "closed", 42, false],
      ["issue_comment", "created", 42, false],
    ] as const) {
      expect(
        Boolean(
          runInNewContext(commands[0]!.if!, {
            github: { event_name: eventName, event: { action, pull_request: { number: 42 } } },
            matrix: { pr: target },
          }),
        ),
      ).toBe(allowed);
    }
    expect(commands[1]?.if).toBe(
      "github.event_name == 'pull_request_target' && github.event.action != 'closed' && matrix.pr == github.event.pull_request.number && steps.detect.outputs.autoscrub == 'true'",
    );
    for (const [runtime, cancelled, allowed] of [
      ["success", false, true],
      ["failure", false, false],
      ["skipped", false, false],
      ["success", true, false],
    ] as const) {
      expect(
        Boolean(
          runInNewContext(commands[2]!.if!.replace(/^\$\{\{|\}\}$/gu, ""), {
            steps: { runtime: { outcome: runtime } },
            cancelled: () => cancelled,
          }),
        ),
      ).toBe(allowed);
    }
    const tokenSteps = steps.filter((step) =>
      step.uses?.startsWith("actions/create-github-app-token@"),
    );
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

  it("loads the selected resolver closure without workspace dependencies", () => {
    const workspace = tempDirs.make("openclaw-security-resolve-source-");
    materializeJobSources(workspace, "resolve");
    stageJobSources(workspace, "resolve");
    const entry = "security-review-event.mjs";
    const result = runSelectedEntry(workspace, entry);
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(
      "GitHub token, event, event name, and repository are required.",
    );

    rmSync(join(workspace, "scripts/lib/bounded-response.mjs"));
    const missingModule = runSelectedEntry(workspace, entry);
    expect(missingModule.status).toBe(1);
    expect(missingModule.stderr).toContain("ERR_MODULE_NOT_FOUND");
    expect(missingModule.stderr).toContain("bounded-response.mjs");
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
      const installed = JSON.parse(readFileSync(installLog, "utf8")) as {
        args: string[];
        cwd: string;
        manifest: unknown;
        lock: unknown;
      };
      expect(installed.args).toEqual(["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
      expect(installed.cwd.startsWith(`${realpathSync(runnerTemp)}/`)).toBe(true);
      expect(installed.manifest).toEqual(
        JSON.parse(readFileSync(`${runtimeActionPath}/package.json`, "utf8")),
      );
      expect(installed.lock).toEqual(
        JSON.parse(readFileSync(`${runtimeActionPath}/package-lock.json`, "utf8")),
      );
      const probe = join(workspace, "scripts/github/probe.mjs");
      writeFileSync(
        probe,
        'import { parse } from "yaml"; import { minimatch } from "minimatch"; import { loadSecurityReviewPolicy } from "./security-review-policy.mjs"; console.log(JSON.stringify([parse("category: secrets").category, minimatch("src/secrets/.store/key", "src/secrets/**", { dot: true }), loadSecurityReviewPolicy().isDependencyManifest("package.json")]));',
      );
      expect(
        JSON.parse(execFileSync(process.execPath, [probe], { env: {}, encoding: "utf8" })),
      ).toEqual(["secrets", true, true]);
      const entry = "security-review.mjs";
      const loaded = runSelectedEntry(workspace, entry);
      expect(loaded.status).toBe(1);
      expect(loaded.stderr.trim()).toBe(
        "GITHUB_TOKEN, GITHUB_EVENT_PATH, and GITHUB_REPOSITORY are required.",
      );

      rmSync(join(workspace, ".github/security-review-policy.yml"));
      const missingPolicy = spawnSync(process.execPath, [probe], {
        cwd: workspace,
        env: {},
        encoding: "utf8",
      });
      expect(missingPolicy.status).toBe(1);
      expect(missingPolicy.stderr).toContain("ENOENT");
      expect(missingPolicy.stderr).toContain("security-review-policy.yml");
    },
  );

  it("keeps the frozen runtime dependency closure on the canonical repository pins and integrity", () => {
    const manifest = JSON.parse(readFileSync(`${runtimeActionPath}/package.json`, "utf8")) as {
      dependencies: Record<string, string>;
      overrides: Record<string, string>;
    };
    const root = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies: Record<string, string>;
    };
    const workspace = parse(readFileSync("pnpm-workspace.yaml", "utf8")) as {
      overrides: Record<string, string>;
    };
    const canonical = parse(
      pnpmLockfileDocuments(readFileSync("pnpm-lock.yaml", "utf8")).dependencies,
    ) as {
      packages: Record<string, { resolution: { integrity: string } }>;
      snapshots: Record<string, { dependencies?: Record<string, string> }>;
    };
    const lock = JSON.parse(readFileSync(`${runtimeActionPath}/package-lock.json`, "utf8")) as {
      packages: Record<
        string,
        { version: string; integrity: string; dependencies?: Record<string, string> }
      >;
    };
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
    ".github/CODEOWNERS",
    "SECURITY.md",
    ".github/codeql/codeql-core-auth-secrets-critical-security.yml",
    ".github/codeql/openclaw-boundary/queries/managed-proxy-runtime-mutation.ql",
    ".github/workflows/codeql-macos-critical-security.yml",
    ".github/workflows/security-review.yml",
    ".github/security-review-policy.yml",
    ".github/actions/setup-security-review/action.yml",
    ".github/actions/setup-security-review/package.json",
    ".github/actions/setup-security-review/package-lock.json",
    "scripts/github/security-review-policy.mjs",
    "scripts/github/security-review-event.mjs",
    "scripts/github/security-review.mjs",
    "scripts/github/security-review-rollout.mjs",
    "scripts/github/guard-review.mjs",
    "scripts/github/guard-shared.mjs",
    "scripts/lib/bounded-response.mjs",
  ])("requires SecOps alone for %s", (path) => {
    expect(ownersFor(path)).toEqual(["@openclaw/openclaw-secops"]);
  });

  it.each([
    "src/gateway/auth.ts",
    "src/secrets/store/secret-store.ts",
    "src/agents/sandbox.ts",
    "pnpm-lock.yaml",
    ".gitignore",
    "docs/gateway/secrets.md",
  ])("leaves maintainer review authority for %s", (path) => {
    expect(ownersFor(path)).toEqual([]);
  });

  it("preserves separate release-manager ownership", () => {
    expect(ownersFor(".github/workflows/openclaw-npm-release.yml")).toEqual([
      "@openclaw/openclaw-release-managers",
    ]);
  });
});
