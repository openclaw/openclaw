import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  evaluateWorkflowCondition,
  expectIncludes,
  readWorkflowOutputs as readGitHubEnvironment,
  requiredWorkflowStep,
  readWorkflow,
} from "./ci-workflow.test-support.js";

type WorkflowStep = {
  env?: Record<string, string>;
  if?: string;
  name?: string;
  run?: string;
  with?: Record<string, unknown>;
};

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scannerPath = "scripts/detect-private-keys.mts";
const localGitEnvironment = {
  GIT_ALLOW_PROTOCOL: "file",
  GIT_CONFIG_COUNT: "0",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
const localGitCommand = "GIT_ALLOW_PROTOCOL=file GIT_CONFIG_COUNT=0";
const neuteredScanner = "process.exit(0);\n";

const securitySteps: WorkflowStep[] = readWorkflow(".github/workflows/ci.yml").jobs["security-fast"]
  .steps;
function securityStep(name: string): WorkflowStep {
  return requiredWorkflowStep(securitySteps, name);
}

function securityStepIndex(name: string): number {
  return securitySteps.indexOf(securityStep(name));
}

function writeExecutable(filePath: string, source: string): void {
  writeFileSync(filePath, source, "utf8");
  chmodSync(filePath, 0o755);
}

function runGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...localGitEnvironment },
  }).trim();
}

function runStep(step: WorkflowStep, cwd: string, env: NodeJS.ProcessEnv) {
  if (!step.run) {
    throw new Error(`workflow step has no shell body: ${step.name ?? "unknown"}`);
  }
  return spawnSync("bash", ["-euo", "pipefail", "-c", step.run], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...step.env, ...env },
  });
}

function createFixture() {
  const root = tempDirs.make("openclaw-security-fast-");
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const runnerTemp = join(root, "runner");
  const githubEnv = join(root, "github-env");
  for (const dir of [join(repo, ".github"), join(repo, "scripts"), bin, runnerTemp]) {
    mkdirSync(dir, { recursive: true });
  }
  const write = (files: Record<string, string | Buffer>) => {
    for (const [file, contents] of Object.entries(files)) {
      const destination = join(repo, file);
      mkdirSync(join(destination, ".."), { recursive: true });
      writeFileSync(destination, contents);
    }
  };
  const git = (...args: string[]) => runGit(repo, ...args);
  const commit = (message: string) => {
    git("add", ".");
    git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  };

  git("init", "--initial-branch=main");
  git("config", "user.name", "CI Fixture");
  git("config", "user.email", "ci@example.invalid");
  git("commit", "--allow-empty", "-m", "initial");
  const missingPolicySha = git("rev-parse", "HEAD");
  const realScanner = readFileSync(resolve(scannerPath));
  write({ ".github/zizmor.yml": "rules:\n  trusted-base: {}\n", [scannerPath]: realScanner });
  const baseSha = commit("base policy");

  // The candidate poisons every input it could: policy, hook config, and the
  // scanner itself, while adding a key the neutered scanner would let through.
  write({
    ".github/zizmor.yml": "rules:\n  candidate-poison: {}\n",
    ".pre-commit-config.yaml": "repos:\n  - repo: https://example.invalid/poison.git\n",
    [scannerPath]: neuteredScanner,
    "leaked.pem": "-----BEGIN RSA PRIVATE KEY-----\nfixture only\n",
  });
  commit("candidate policy");

  write({
    ".ci-harness/.github/zizmor.yml": "rules:\n  trusted-harness: {}\n",
    [`.ci-harness/${scannerPath}`]: realScanner,
  });

  const realGit = execFileSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim();
  writeExecutable(
    join(bin, "git"),
    `#!/bin/sh
skip_value=0
command=
for arg in "$@"; do
  if [ "$skip_value" = 1 ]; then
    skip_value=0
    continue
  fi
  case "$arg" in
    -c|-C|--config-env|--exec-path|--git-dir|--namespace|--work-tree)
      skip_value=1
      ;;
    -*)
      ;;
    *)
      command="$arg"
      break
      ;;
  esac
done
case "$command" in
  clone|fetch|ls-remote)
    echo "network Git is forbidden in security-fast" >&2
    exit 97
    ;;
esac
exec "$OPENCLAW_TEST_REAL_GIT" "$@"
`,
  );

  const environment = {
    GITHUB_ENV: githubEnv,
    OPENCLAW_TEST_REAL_GIT: realGit,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    RUNNER_TEMP: runnerTemp,
  };
  const run = (step: WorkflowStep | string, env: NodeJS.ProcessEnv = {}) =>
    runStep(typeof step === "string" ? securityStep(step) : step, repo, { ...environment, ...env });
  return {
    write,
    git,
    commit,
    run,
    baseSha,
    missingPolicySha,
    realScanner,
    runnerTemp,
    read: (name: string) => readFileSync(join(runnerTemp, name), "utf8"),
    prepare: (eventName: "pull_request" | "push" | "workflow_dispatch", sha = baseSha) => {
      const result = run("Prepare trusted scanner config", {
        BASE_SHA: sha,
        GITHUB_EVENT_NAME: eventName,
      });
      return { result, githubEnvironment: readGitHubEnvironment(githubEnv) };
    },
  };
}

it.each([false, true])(
  "installs workflow scanners only for changed workflow files: %s",
  (changed) => {
    const fixture = createFixture();
    if (changed) {
      fixture.write({ ".github/workflows/example.yml": "name: fixture\n" });
      fixture.commit("workflow input");
    }
    const output = join(fixture.runnerTemp, "output");
    const result = fixture.run("Detect changed GitHub workflows", {
      BASE_SHA: fixture.baseSha,
      GITHUB_OUTPUT: output,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readGitHubEnvironment(output).changed).toBe(changed ? "true" : undefined);
    expect(fixture.read("security-workflow-files")).toBe(
      changed ? ".github/workflows/example.yml\n" : "",
    );
    for (const name of [
      "Install security scanners",
      "Audit changed GitHub workflows with zizmor",
    ]) {
      expect(
        evaluateWorkflowCondition(expectDefined(securityStep(name).if, "scanner condition"), {
          eventName: "pull_request",
          repository: "openclaw/openclaw",
          runAttempt: 1,
          failed: true,
          steps: {
            workflow_scope: { outputs: { changed: String(changed) } },
            security_scanners: { outputs: {}, outcome: "success" },
            scanner_config: { outputs: {}, outcome: "success" },
          },
        }),
      ).toBe(changed);
      expect(securityStepIndex("Detect changed GitHub workflows")).toBeLessThan(
        securityStepIndex(name),
      );
    }
  },
);

it.each(["pull_request", "push", "schedule", "workflow_dispatch"] as const)(
  "runs the production audit only for release dispatches: %s",
  (eventName) => {
    const audit = securityStep("Audit production dependencies");
    expect(audit.if).toBeDefined();
    for (const [dispatchId, release] of [
      ["", false],
      ["manual-ci", false],
      ["full-release-validation", false],
      ["release-native-android", false],
      ["full-release-validation-1-1-ci", true],
      ["release-native-android-1-1-a", true],
    ] as const) {
      expect(
        evaluateWorkflowCondition(expectDefined(audit.if, "audit condition"), {
          eventName,
          dispatchId,
          steps: { node_setup: { outputs: {}, outcome: "success" } },
          repository: "openclaw/openclaw",
          runAttempt: 1,
        }),
        `${eventName}: ${dispatchId}`,
      ).toBe(eventName === "workflow_dispatch" && release);
    }
  },
);

it.each([0, 1, 2, 130])(
  "warns without blocking CI or pre-commit for audit exit %s, retaining the strict daily audit",
  (auditExit) => {
    const repo = tempDirs.make("openclaw-audit-ci-");
    mkdirSync(join(repo, "scripts", "pre-commit"), { recursive: true });
    mkdirSync(join(repo, ".ci-harness", "scripts"), { recursive: true });
    writeFileSync(
      join(repo, "scripts", "pre-commit", "pnpm-audit-prod.mjs"),
      `console.log("audit report"); process.exit(${auditExit});\n`,
    );
    for (const directory of [".ci-harness/scripts", "scripts"]) {
      writeFileSync(
        join(repo, directory, "ci-production-audit.mjs"),
        readFileSync("scripts/ci-production-audit.mjs"),
      );
    }
    expect(securityStep("Checkout trusted CI harness").with?.["sparse-checkout"]).toContain(
      "scripts/ci-production-audit.mjs",
    );
    const audit = securityStep("Audit production dependencies");
    const hooks = parse(readFileSync(".pre-commit-config.yaml", "utf8")) as {
      repos: Array<{ hooks: Array<{ id: string; entry: string; verbose?: boolean }> }>;
    };
    const hook = hooks.repos
      .flatMap((entry) => entry.hooks)
      .find((candidate) => candidate.id === "pnpm-audit-prod");
    expect(hook).toBeDefined();
    expect(hook?.verbose).toBe(true);
    for (const step of [audit, { run: hook!.entry }]) {
      const result = runStep(step, repo, { GITHUB_EVENT_NAME: "", GITHUB_EVENT_PATH: "" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("audit report\n");
      if (auditExit === 0) {
        expect(result.stdout).not.toContain("::warning");
      } else {
        expectIncludes(result.stdout, [
          "::warning title=Dependency audit is non-blocking::",
          `Production dependency audit exited ${auditExit}.`,
          "daily Dependency Audit workflow",
          "dependency bump on main",
        ]);
      }
    }
    const scheduled = parse(readFileSync(".github/workflows/dependency-audit.yml", "utf8")) as {
      jobs: { audit: { steps: WorkflowStep[] } };
    };
    const strictStep = requiredWorkflowStep(
      scheduled.jobs.audit.steps,
      "Audit production dependencies",
    );
    const summary = join(repo, "summary.md");
    const strict = runStep(strictStep, repo, { GITHUB_STEP_SUMMARY: summary });
    expect(strict.status).toBe(auditExit);
    expect(readFileSync(summary, "utf8")).toContain("Triage owner: @steipete");
  },
);

it("generates the exact local-only scanner contract from trusted policy", () => {
  const checkoutHarness = securityStep("Checkout trusted CI harness");
  const prepare = securityStep("Prepare trusted scanner config");
  const install = securityStep("Install security scanners");
  const detect = securityStep("Detect committed private keys");
  const zizmor = securityStep("Audit changed GitHub workflows with zizmor");

  expect(checkoutHarness.with).toMatchObject({
    ref: "${{ github.workflow_sha }}",
    "persist-credentials": false,
  });
  expectIncludes(checkoutHarness.with?.["sparse-checkout"], [".github/zizmor.yml", scannerPath]);
  expect(securitySteps.some((step) => step.name === "Resolve Python runtime")).toBe(false);
  expect(install.run).toContain("python3 --version");
  expect(install.run).toContain("pre-commit==4.6.2 zizmor==1.30.1");
  expect(install.run).not.toContain("pre-commit-hooks");
  expect(prepare.run).not.toMatch(/origin\/|BASE_REF|PRE_COMMIT_CONFIG_PATH:-/u);
  // The first-party key scan runs before any package install can fail or
  // execute third-party code, and never through pre-commit.
  expect(detect.run).toBe('node "$PRIVATE_KEY_SCANNER_PATH"');
  expect(securityStepIndex("Setup Node.js")).toBeLessThan(securityStepIndex(detect.name!));
  expect(securityStepIndex(detect.name!)).toBeLessThan(securityStepIndex(install.name!));
  expect(zizmor.run).toContain(localGitCommand);

  const fixture = createFixture();
  const prepared = fixture.prepare("pull_request");
  expect(prepared.result.status, `${prepared.result.stdout}${prepared.result.stderr}`).toBe(0);
  const configPath = prepared.githubEnvironment.PRE_COMMIT_CONFIG_PATH;
  if (!configPath) {
    throw new Error("scanner config path was not published");
  }
  const config = parse(readFileSync(configPath, "utf8")) as {
    repos: Array<{ hooks: Array<Record<string, unknown>>; repo: string }>;
  };
  const expectedHook = {
    id: "zizmor",
    name: "zizmor",
    entry: "zizmor",
    language: "system",
    types: ["yaml"],
    files: String.raw`(\.github/(workflows/.*|dependabot.ya?ml))|(action\.ya?ml)$`,
    require_serial: true,
    args: [
      "--config",
      join(fixture.runnerTemp, "zizmor.yml"),
      "--persona=regular",
      "--min-severity=medium",
      "--min-confidence=medium",
    ],
    exclude: "^(vendor/|apps/swabble/)",
  };
  expect(config.repos).toEqual([{ repo: "local", hooks: [expectedHook] }]);
  expect(fixture.read("zizmor.yml")).toBe("rules:\n  trusted-base: {}\n");
  expect(readFileSync(configPath, "utf8")).not.toContain("example.invalid");

  const trustedScanner = prepared.githubEnvironment.PRIVATE_KEY_SCANNER_PATH;
  expect(trustedScanner).toBe(join(fixture.runnerTemp, "detect-private-keys.mts"));
  expect(readFileSync(trustedScanner!)).toEqual(fixture.realScanner);

  const scanned = fixture.run(detect, prepared.githubEnvironment);
  expect(scanned.status).toBe(1);
  expectIncludes(scanned.stderr, [
    "Private key found: leaked.pem (BEGIN RSA PRIVATE KEY)",
    "[detect-private-keys] FAILED (exit 1)",
  ]);
});

it("fails closed for a missing exact-base policy and trusts the harness otherwise", () => {
  const missing = createFixture();
  const rejected = missing.prepare("pull_request", missing.missingPolicySha);
  expect(rejected.result.status).not.toBe(0);
  expect(`${rejected.result.stdout}${rejected.result.stderr}`).toContain(
    "trusted zizmor policy unavailable",
  );
  expect(rejected.githubEnvironment).toEqual({});

  for (const eventName of ["push", "workflow_dispatch"] as const) {
    const fixture = createFixture();
    const prepared = fixture.prepare(eventName);
    expect(prepared.result.status, `${prepared.result.stdout}${prepared.result.stderr}`).toBe(0);
    expect(fixture.read("zizmor.yml")).toBe("rules:\n  trusted-harness: {}\n");
    expect(readFileSync(join(fixture.runnerTemp, "detect-private-keys.mts"))).toEqual(
      fixture.realScanner,
    );
  }
});

it("fails closed when the exact base has no scanner instead of running the candidate copy", () => {
  const fixture = createFixture();
  // A base with the policy but not the scanner: the bootstrap gap a
  // candidate could otherwise exploit with a neutered scanner.
  fixture.write({ ".github/zizmor.yml": "rules:\n  trusted-base: {}\n" });
  fixture.git("rm", "-q", "--cached", scannerPath);
  // Only commit the policy: the poisoned scanner must remain untracked here.
  fixture.git("add", ".github/zizmor.yml");
  fixture.git("commit", "-m", "base without scanner");
  const rejected = fixture.prepare("pull_request", fixture.git("rev-parse", "HEAD"));
  expect(rejected.result.status).not.toBe(0);
  expect(`${rejected.result.stdout}${rejected.result.stderr}`).toContain(
    "trusted private-key scanner unavailable",
  );
  expect(rejected.githubEnvironment).toEqual({});
  expect(existsSync(join(fixture.runnerTemp, "detect-private-keys.mts"))).toBe(false);
});
