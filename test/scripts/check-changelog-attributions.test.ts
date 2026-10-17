import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  findForbiddenChangelogThanks,
  isForbiddenChangelogThanksHandle,
  requiresExplicitHumanChangelogThanks,
} from "../../scripts/check-changelog-attributions.mts";

const changelogScriptPath = path.join(process.cwd(), "scripts", "pr-lib", "changelog.sh");
const commonScriptPath = path.join(process.cwd(), "scripts", "pr-lib", "common.sh");
const gatesScriptPath = path.join(process.cwd(), "scripts", "pr-lib", "gates.sh");
const reviewScriptPath = path.join(process.cwd(), "scripts", "pr-lib", "review.sh");

function run(cwd: string, command: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commandOutput(error: unknown): string {
  const result = error as { stderr?: unknown; stdout?: unknown };
  return `${(result.stdout ?? "") as string}${(result.stderr ?? "") as string}`;
}

function createRepoWithPrChangelogDiff(entry: string): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), "openclaw-changelog-credit-"));
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

function validateChangelogEntry(repo: string, contrib: string): string {
  return run(
    repo,
    "bash",
    [
      "-c",
      'source "$OPENCLAW_PR_CHANGELOG_SH"; PR_MAIN_SHA=$(git rev-parse --verify refs/remotes/origin/main); validate_changelog_entry_for_pr 123 "$OPENCLAW_TEST_CONTRIB"',
    ],
    {
      OPENCLAW_PR_CHANGELOG_SH: changelogScriptPath,
      OPENCLAW_TEST_CONTRIB: contrib,
    },
  );
}

function runPrepareGates(repo: string, callsPath: string): string {
  return run(
    repo,
    "bash",
    [
      "-c",
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
    ],
    {
      OPENCLAW_PR_COMMON_SH: commonScriptPath,
      OPENCLAW_PR_CHANGELOG_SH: changelogScriptPath,
      OPENCLAW_PR_GATES_SH: gatesScriptPath,
      OPENCLAW_PR_REVIEW_SH: reviewScriptPath,
      OPENCLAW_TEST_CALLS: callsPath,
      OPENCLAW_TESTBOX: "0",
    },
  );
}

describe("check-changelog-attributions", () => {
  it("flags forbidden bot, org, and maintainer thanks attributions", () => {
    const lines = [
      "- Internal cleanup. Thanks @codex.",
      "- Org-owned fix. Thanks @openclaw.",
      "- Maintainer-owned fix. Thanks @steipete.",
      "- Mixed credit. Thanks @contributor and @OpenClaw.",
      "- Bot repair. Thanks @clawsweeper[bot].",
      "- Dependency bump. Thanks @dependabot[bot].",
      "- App repair. Thanks @app/clawsweeper.",
    ];
    const handles =
      "codex openclaw steipete openclaw clawsweeper[bot] dependabot[bot] app/clawsweeper".split(
        " ",
      );
    expect(findForbiddenChangelogThanks(lines.join("\n"))).toEqual(
      handles.map((handle, index) => ({ line: index + 1, handle, text: lines[index] })),
    );
  });

  it("allows external contributor thanks attributions", () => {
    expect(
      findForbiddenChangelogThanks(
        "- User-facing fix. Fixes #123. Thanks @external-contributor and @other-user.",
      ),
    ).toStrictEqual([]);
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
    expect(isForbiddenChangelogThanksHandle("dependabot[bot]", { strictBotHandle: true })).toBe(
      true,
    );
    expect(
      isForbiddenChangelogThanksHandle("human-clawsweeper-fan", { strictBotHandle: true }),
    ).toBe(false);
  });

  it("requires explicit human thanks for bot PR changelog entries", () => {
    const repo = createRepoWithPrChangelogDiff("- Bot repair (#123).");
    try {
      let output = "";
      try {
        validateChangelogEntry(repo, "dependabot[bot]");
      } catch (error) {
        output = String((error as { stdout?: unknown }).stdout ?? error);
      }
      expect(output).toContain("must include an explicit human Thanks @handle");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects root changelog updates from normal prepare gates", () => {
    const repo = createRepoWithPrChangelogDiff("- User fix (#123). Thanks @alice.");
    const callsPath = path.join(repo, "calls.log");
    mkdirSync(path.join(repo, ".local"));
    writeFileSync(path.join(repo, ".local", "pr-meta.env"), "PR_AUTHOR=alice\n", "utf8");
    try {
      let output = "";
      try {
        runPrepareGates(repo, callsPath);
      } catch (error) {
        output = commandOutput(error);
      }
      const calls = existsSync(callsPath) ? readFileSync(callsPath, "utf8") : "";

      expect(output).toContain("CHANGELOG.md is release-owned");
      expect(calls).not.toContain("policy");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
