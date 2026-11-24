import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";
import {
  evaluateWorkflow,
  readWorkflowOutputs,
  requiredWorkflowStep,
  runWorkflowShellScript,
  type WorkflowStep,
} from "./ci-workflow.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const workflow = parse(fs.readFileSync(".github/workflows/ci.yml", "utf8"), {
  maxAliasCount: 10000,
});
function step(job: string, name: string): string {
  const selected = workflow.jobs[job].steps.find((entry: { name: string }) => entry.name === name);
  if (!selected?.run) {
    throw new Error(`Missing ${job}/${name}`);
  }
  return selected.run;
}

const expectedBase = "a".repeat(40);
const expectedCandidate = "b".repeat(40);
const merge = "c".repeat(40);
const fork = "d".repeat(40);
function compare(gh: string, merged = false) {
  const root = tempDirs.make("openclaw-ci-ratchet-base-");
  const output = path.join(root, "output");
  const apiLog = path.join(root, "api");
  const run = runWorkflowShellScript(
    `${gh}\n${step("preflight", "Resolve checkout comparison base")}`,
    {
      cwd: root,
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: "openclaw/openclaw",
        BASE_SHA: expectedBase,
        CHECKOUT_SHA: merged ? merge : expectedCandidate,
        DIFF_HEAD_SHA: merge,
        API_LOG: apiLog,
        FORK_SHA: fork,
      },
    },
  );
  expect(run.error).toBeUndefined();
  return { run, root, output, apiLog };
}

it.each([false, true])(
  "uses the actual checkout base for asset checks (merge tree=%s)",
  (merged) => {
    const { run, root, output, apiLog } = compare(
      'gh() { printf "%s\\n" "$*" >> "$API_LOG"; printf "%s\\n" "$FORK_SHA"; }',
      merged,
    );
    expect(run.status, run.stderr).toBe(0);
    expect(fs.readFileSync(output, "utf8")).toBe(`sha=${merged ? expectedBase : fork}\n`);
    if (merged) {
      expect(fs.existsSync(apiLog)).toBe(false);
    } else {
      expect(fs.readFileSync(apiLog, "utf8")).toBe(
        `api --method GET repos/openclaw/openclaw/compare/${expectedBase}...${expectedCandidate} --jq .merge_base_commit.sha\n`,
      );
    }
    const context = {
      preflightOutputs: {
        checkout_base_revision: expectDefined(readWorkflowOutputs(output).sha, "checkout base"),
        diff_base_revision: expectedBase,
      },
    };
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { "ui:check-performance:base": "fixture" } }),
    );
    const assets = runWorkflowShellScript(
      `pnpm() { printf '%s\\n' "$@"; }\n${step("control-ui-performance", "Check Control UI performance against base")}`,
      {
        cwd: root,
        env: {
          ...process.env,
          CHECKOUT_BASE_SHA: String(
            evaluateWorkflow(
              workflow.jobs["control-ui-performance"].env.CHECKOUT_BASE_SHA,
              context,
            ),
          ),
          COMPATIBILITY_TARGET: "false",
        },
      },
    );
    expect(assets.status, assets.stderr).toBe(0);
    expect(assets.stdout.trim().split("\n")).toEqual([
      "ui:check-performance:base",
      merged ? expectedBase : fork,
    ]);
    for (const expression of [
      workflow.jobs["checks-baseline-ratchets"].env.CHECKOUT_BASE_SHA,
      requiredWorkflowStep<WorkflowStep[]>(
        workflow.jobs["checks-fast-core"].steps,
        "Run ${{ matrix.task }} (${{ matrix.runtime }})",
      ).env?.PROTOCOL_SINCE_BASE_SHA,
      requiredWorkflowStep<WorkflowStep[]>(
        workflow.jobs["check-additional-shard"].steps,
        "Ensure additional check comparison base",
      ).with?.["base-sha"],
    ]) {
      expect(evaluateWorkflow(expression, context)).toBe(expectedBase);
    }
  },
);

it("refuses an unavailable API ancestor without publishing a fallback", () => {
  const { run, output } = compare("gh() { return 1; }");
  expect(run.status, run.stderr).toBe(1);
  expect(fs.existsSync(output)).toBe(false);
});

it.skipIf(process.platform !== "linux").each([false, true])(
  "admits an ordinary depth-one merge with its target parser (historical=%s)",
  (historical) => {
    const source = tempDirs.make("openclaw-ci-ratchet-history-");
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
        cwd,
        env: createNestedGitEnv(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git(source, "init", "-b", "main");
    git(source, "commit", "--allow-empty", "-m", "base");
    const base = git(source, "rev-parse", "HEAD");
    git(source, "checkout", "-b", "candidate");
    git(source, "commit", "--allow-empty", "-m", "candidate");
    git(source, "checkout", "main");
    git(source, "merge", "--no-ff", "candidate", "-m", "merge");
    const root = tempDirs.make("openclaw-ci-ratchet-shallow-");
    git(root, "clone", "--depth=1", pathToFileURL(source).href, ".");
    git(root, "fetch", "--depth=1", "origin", `${base}:refs/remotes/origin/ci-ratchet-base`);
    expect(spawnSync("git", ["merge-base", "HEAD", base], { cwd: root }).status).not.toBe(0);
    fs.mkdirSync(path.join(root, "scripts/lib"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "scripts/lib/shrink-ratchet.mts"),
      historical
        ? 'export function parseRatchetArgs(args) { if (args.includes("--no-merge-base")) throw new Error("Unknown argument"); return { base: args[1] }; }\n'
        : fs.readFileSync("scripts/lib/shrink-ratchet.mts", "utf8"),
    );
    const result = runWorkflowShellScript(
      `set -euo pipefail
source '${path.resolve("scripts/ci-collect-checks.sh")}'
prepare_ratchet_base_args '${base}'
printf '%s\\n' "\${ratchet_base_args[@]}"`,
      { cwd: root, env: createNestedGitEnv() },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "--base",
      base,
      ...(historical ? [] : ["--no-merge-base"]),
    ]);
  },
);
