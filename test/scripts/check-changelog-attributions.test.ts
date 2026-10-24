import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it } from "vitest";
import {
  findForbiddenChangelogThanks,
  isForbiddenChangelogThanksHandle,
  requiresExplicitHumanChangelogThanks,
} from "../../scripts/check-changelog-attributions.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempRoots = useAutoCleanupTempDirTracker(afterEach);
const scriptEnv = Object.fromEntries(
  ["changelog", "common", "gates", "review"].map((name) => [
    `OPENCLAW_PR_${name.toUpperCase()}_SH`,
    path.resolve("scripts/pr-lib", `${name}.sh`),
  ]),
);

function run(cwd: string, command: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function shell(repo: string, source: string, env: NodeJS.ProcessEnv = {}) {
  return run(repo, "bash", ["-c", source], { ...scriptEnv, ...env });
}

function failureOutput(action: () => string, stdoutOnly = false): string {
  try {
    action();
    return "";
  } catch (error) {
    const result = asOptionalRecord(error);
    const stdout = result?.stdout ?? "";
    const stderr = result?.stderr ?? "";
    if (typeof stdout !== "string" || typeof stderr !== "string") {
      throw error;
    }
    return stdout + (stdoutOnly ? "" : stderr);
  }
}

function createRepoWithPrChangelogDiff(entry: string): string {
  const repo = tempRoots.make("openclaw-changelog-credit-");
  const git = (args: string[]) =>
    run(repo, "git", ["-c", "user.email=test@example.com", "-c", "user.name=Test User", ...args]);
  git(["init", "-q", "--initial-branch=main"]);
  const header = "# Changelog\n\n## Unreleased\n\n### Fixes\n\n";
  writeFileSync(repo + "/CHANGELOG.md", header, "utf8");
  git(["add", "CHANGELOG.md"]);
  git(["commit", "-qm", "seed"]);
  const baseSha = git(["rev-parse", "HEAD"]);
  // Direct helper callers capture this base as the operation's main snapshot.
  git(["update-ref", "refs/remotes/origin/main", baseSha]);
  git(["checkout", "-qb", "feature"]);
  writeFileSync(repo + "/CHANGELOG.md", `${header}${entry}\n`, "utf8");
  git(["add", "CHANGELOG.md"]);
  git(["commit", "-qm", "add changelog entry"]);
  return repo;
}

function runPrepareGates(repo: string, callsPath: string): string {
  return shell(
    repo,
    `
set -euo pipefail
source "$OPENCLAW_PR_COMMON_SH"
source "$OPENCLAW_PR_CHANGELOG_SH"
source "$OPENCLAW_PR_GATES_SH"
source "$OPENCLAW_PR_REVIEW_SH"

pr_gh() { printf '{"headRefName":"feature"}\\n'; }
enter_worktree() { PR_MAIN_SHA=$(git rev-parse --verify refs/remotes/origin/main); }
checkout_prep_branch() { :; }
refresh_prep_branch_for_reviewed_head() { :; }
# Preparation tests cover review admission; these fixtures isolate changelog policy.
require_prepared_review() { :; }
bootstrap_deps_if_needed() { :; }
require_artifact() { [ -s "$1" ]; }
validate_changelog_attribution_policy() { printf 'policy\\n' >>"$OPENCLAW_TEST_CALLS"; }
validate_changelog_merge_hygiene() { printf 'merge-hygiene\\n' >>"$OPENCLAW_TEST_CALLS"; }
validate_changelog_entry_for_pr() { printf 'entry:%s:%s\\n' "$1" "$2" >>"$OPENCLAW_TEST_CALLS"; }
run_quiet_logged() { printf 'gate:%s\\n' "$1" >>"$OPENCLAW_TEST_CALLS"; }

prepare_gates 123
`,
    { OPENCLAW_TEST_CALLS: callsPath, OPENCLAW_TESTBOX: "0" },
  );
}

describe("check-changelog-attributions", () => {
  it("flags forbidden bot, org, and maintainer thanks attributions", () => {
    const lines =
      "codex|openclaw|steipete|contributor and @OpenClaw|clawsweeper[bot]|dependabot[bot]|app/clawsweeper"
        .split("|")
        .map((handle) => `- Fix. Thanks @${handle}.`);
    const handles =
      "codex openclaw steipete openclaw clawsweeper[bot] dependabot[bot] app/clawsweeper".split(
        " ",
      );
    expect(findForbiddenChangelogThanks(lines.join("\n"))).toEqual(
      handles.map((handle, index) => ({ line: index + 1, handle, text: lines[index] })),
    );
  });

  it("allows external contributor thanks attributions", () => {
    const text = "- Fix. Thanks @external-contributor and @other-user.";
    expect(findForbiddenChangelogThanks(text)).toStrictEqual([]);
  });

  it("uses one attribution predicate for scanner and shell checks", () => {
    function check(handles: string, forbidden: boolean, humanRequired: boolean) {
      for (const handle of handles.split("|")) {
        expect(isForbiddenChangelogThanksHandle(handle), handle).toBe(forbidden);
        expect(requiresExplicitHumanChangelogThanks(handle), handle).toBe(humanRequired);
      }
    }
    check("|null|codex|openclaw|steipete", true, false);
    check(
      "app/any-bot|app/clawsweeper|clawsweeper|clawsweeper[bot]|openclaw-clawsweeper|openclaw-clawsweeper[bot]|dependabot[bot]",
      true,
      true,
    );
    check("alice|human-clawsweeper-fan", false, false);
    expect(
      ["dependabot[bot]", "human-clawsweeper-fan"].map((handle) =>
        isForbiddenChangelogThanksHandle(handle, { strictBotHandle: true }),
      ),
    ).toEqual([true, false]);
  });

  it("requires explicit human thanks for bot PR changelog entries", () => {
    const repo = createRepoWithPrChangelogDiff("- Bot repair (#123).");
    const script =
      'source "$OPENCLAW_PR_CHANGELOG_SH"; PR_MAIN_SHA=$(git rev-parse --verify refs/remotes/origin/main); validate_changelog_entry_for_pr 123 "dependabot[bot]"';
    expect(failureOutput(() => shell(repo, script), true)).toContain(
      "must include an explicit human Thanks @handle",
    );
  });

  it("rejects root changelog updates from normal prepare gates", () => {
    const repo = createRepoWithPrChangelogDiff("- User fix (#123). Thanks @alice.");
    const callsPath = path.join(repo, "calls.log");
    mkdirSync(path.join(repo, ".local"));
    writeFileSync(path.join(repo, ".local", "pr-meta.env"), "PR_AUTHOR=alice\n", "utf8");
    expect(failureOutput(() => runPrepareGates(repo, callsPath))).toContain(
      "CHANGELOG.md is release-owned",
    );
    expect(existsSync(callsPath) ? readFileSync(callsPath, "utf8") : "").not.toContain("policy");
  });
});
