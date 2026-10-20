import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";
import { runWorkflowShellScript } from "./ci-workflow.test-support.js";

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

describe("CI ratchet comparison ownership", () => {
  it.each([false, true])("resolves the actual checkout comparison (merge tree=%s)", (merged) => {
    const root = tempDirs.make("openclaw-ci-ratchet-base-");
    const base = "a".repeat(40);
    const candidate = "b".repeat(40);
    const merge = "c".repeat(40);
    const fork = "d".repeat(40);
    const output = path.join(root, "output");
    const apiLog = path.join(root, "api");
    const run = runWorkflowShellScript(
      'gh() { printf "%s\\n" "$*" >> "$API_LOG"; printf "%s\\n" "$FORK_SHA"; }\n' +
        step("preflight", "Resolve checkout comparison base"),
      {
        cwd: root,
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: "openclaw/openclaw",
          BASE_SHA: base,
          CHECKOUT_SHA: merged ? merge : candidate,
          DIFF_HEAD_SHA: merge,
          API_LOG: apiLog,
          FORK_SHA: fork,
        },
      },
    );
    expect(run.error).toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    expect(fs.readFileSync(output, "utf8")).toBe(`sha=${merged ? base : fork}\n`);
    if (merged) {
      expect(fs.existsSync(apiLog)).toBe(false);
    } else {
      expect(fs.readFileSync(apiLog, "utf8")).toBe(
        `api --method GET repos/openclaw/openclaw/compare/${base}...${candidate} --jq .merge_base_commit.sha\n`,
      );
    }
  });

  it("refuses an unavailable API ancestor without publishing a fallback", () => {
    const root = tempDirs.make("openclaw-ci-ratchet-error-");
    const output = path.join(root, "output");
    const run = runWorkflowShellScript(
      "gh() { return 1; }\n" + step("preflight", "Resolve checkout comparison base"),
      {
        cwd: root,
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: "openclaw/openclaw",
          BASE_SHA: "a".repeat(40),
          CHECKOUT_SHA: "b".repeat(40),
          DIFF_HEAD_SHA: "c".repeat(40),
        },
      },
    );
    expect(run.error).toBeUndefined();
    expect(run.status, run.stderr).toBe(1);
    expect(fs.existsSync(output)).toBe(false);
  });

  it.skipIf(process.platform !== "linux").each([false, true])(
    "admits an ordinary depth-one merge with its target parser (historical=%s)",
    (historical) => {
      const source = tempDirs.make("openclaw-ci-ratchet-history-");
      const git = (cwd: string, ...args: string[]) =>
        execFileSync(
          "git",
          ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
          { cwd, env: createNestedGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        ).trim();
      git(source, "init", "-b", "main");
      git(source, "commit", "--allow-empty", "-m", "base");
      const base = git(source, "rev-parse", "HEAD");
      git(source, "checkout", "-b", "candidate");
      git(source, "commit", "--allow-empty", "-m", "candidate");
      const candidate = git(source, "rev-parse", "HEAD");
      git(source, "checkout", "main");
      git(source, "merge", "--no-ff", "candidate", "-m", "merge");
      const root = tempDirs.make("openclaw-ci-ratchet-shallow-");
      git(root, "clone", "--depth=1", pathToFileURL(source).href, ".");
      git(root, "fetch", "--depth=1", "origin", `${base}:refs/remotes/origin/ci-ratchet-base`);
      expect(spawnSync("git", ["merge-base", "HEAD", base], { cwd: root }).status).not.toBe(0);
      const scripts = [
        "check:max-lines-ratchet",
        "check:line-cap-ratchet",
        "check:assertion-safety",
        "check:database-worker-ratchet",
        "check:database-dialect-ratchet",
        "check:test-timeout-race-ratchet",
        "check:test-mock-exports",
        "config:docs:check",
        "plugins:inventory:check",
      ];
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ scripts: Object.fromEntries(scripts.map((name) => [name, "true"])) }),
      );
      fs.mkdirSync(path.join(root, "scripts/lib"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "scripts/lib/shrink-ratchet.mts"),
        historical
          ? 'export function parseRatchetArgs(args) { if (args.includes("--no-merge-base")) throw new Error("Unknown argument"); return { base: args[1] }; }\n'
          : fs.readFileSync("scripts/lib/shrink-ratchet.mts", "utf8"),
      );
      const script = step("checks-baseline-ratchets", "Run baseline ratchets").replace(
        "source .ci-harness/scripts/ci-collect-checks.sh",
        `source '${path.resolve("scripts/ci-collect-checks.sh")}'`,
      );
      const run = spawnSync(
        "/bin/bash",
        ["-c", 'pnpm() { printf "CHECK %s\\n" "$*"; }\n' + script],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...createNestedGitEnv(), RATCHET_PR_HEAD_SHA: candidate, RATCHET_BASE_REF: base },
        },
      );
      expect(run.status, run.stderr).toBe(0);
      const calls = run.stdout.split("\n").filter((line) => line.startsWith("CHECK check:"));
      expect(calls).toHaveLength(7);
      for (const call of calls) {
        expect(call).toContain(`--base ${base}`);
        expect(call.includes("--no-merge-base")).toBe(!historical);
      }
      const pushScript = step("security-fast", "Check main push ratchets and protocol additions")
        .replace(
          "source .ci-harness/scripts/ci-collect-checks.sh",
          `source '${path.resolve("scripts/ci-collect-checks.sh")}'`,
        )
        .replace(
          "run_check protocol-additions node --import ./scripts/tsx.mjs scripts/check-protocol-since.mts",
          "run_check protocol-additions true",
        );
      const push = spawnSync(
        "/bin/bash",
        ["-c", 'pnpm() { printf "CHECK %s\\n" "$*"; }\n' + pushScript],
        { cwd: root, encoding: "utf8", env: { ...createNestedGitEnv(), BASE_SHA: base } },
      );
      expect(push.status, push.stderr).toBe(0);
      const pushCalls = push.stdout.split("\n").filter((line) => line.startsWith("CHECK check:"));
      expect(pushCalls).toHaveLength(6);
      for (const call of pushCalls) {
        expect(call).toContain(`--base ${base}`);
        expect(call.includes("--no-merge-base")).toBe(!historical);
      }
    },
  );
});
