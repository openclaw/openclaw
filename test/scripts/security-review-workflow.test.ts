import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ignore from "ignore";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { pnpmLockfileDocuments } from "../../scripts/lib/pnpm-lockfile-documents.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

type WorkflowStep = {
  "continue-on-error"?: boolean;
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

describe("security review workflow trust boundaries", () => {
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
      expect(checkouts).toHaveLength(1);
      expect(checkouts[0]?.with).toMatchObject({
        ref: "${{ github.workflow_sha }}",
        "persist-credentials": false,
      });
      const runtime = job.steps.filter((step) => step.uses === `./${runtimeActionPath}`);
      expect(runtime).toHaveLength(name === "review" ? 1 : 0);
      for (const step of job.steps) {
        if (step.uses && step.uses !== `./${runtimeActionPath}`) {
          expect(step.uses).toMatch(
            /^actions\/(?:checkout|create-github-app-token)@[a-f0-9]{40}$/u,
          );
        }
        if (step.run) {
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
            changes: { body: { from: event.previousBody ?? "" } },
            issue: { pull_request: event.issue ? null : {} },
            workflow_run: { event: event.sourceEvent },
          },
        },
        contains: (value: string, search: string) =>
          value.toLowerCase().includes(search.toLowerCase()),
      });
      expect(Boolean(result), JSON.stringify(event)).toBe(event.allowed);
    }
  });

  it("limits autoscrub writes to PR events and always enforces after failures", () => {
    const steps = readWorkflow("security-review").jobs.review!.steps;
    const commands = steps.filter((step) => step.run);
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
    expect(commands[2]?.if).toBe("always()");
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
      const installSteps = runtimeAction.runs.steps.filter((step) => step.run);
      expect(installSteps).toHaveLength(1);
      expect(installSteps[0]?.shell).toBe("bash");
      execFileSync("bash", ["-c", installSteps[0]!.run!], {
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          GITHUB_ACTION_PATH: resolve(runtimeActionPath),
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
        'import { parse } from "yaml"; import { minimatch } from "minimatch"; console.log(JSON.stringify([parse("category: secrets").category, minimatch("src/secrets/.store/key", "src/secrets/**", { dot: true })]));',
      );
      expect(JSON.parse(execFileSync(process.execPath, [probe], { encoding: "utf8" }))).toEqual([
        "secrets",
        true,
      ]);
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
