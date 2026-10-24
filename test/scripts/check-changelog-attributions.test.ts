import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findForbiddenChangelogThanks,
  isForbiddenChangelogThanksHandle,
  requiresExplicitHumanChangelogThanks,
} from "../../scripts/check-changelog-attributions.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempRoots = useAutoCleanupTempDirTracker(afterEach);
function createRepoWithPrChangelogDiff(entry: string): string {
  const repo = tempRoots.make("openclaw-changelog-credit-");
  const git = (args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.email=test@example.com", "-c", "user.name=Test User", ...args],
      {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
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
    const result = spawnSync("bash", ["-c", script], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_PR_CHANGELOG_SH: path.resolve("scripts/pr-lib/changelog.sh"),
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("must include an explicit human Thanks @handle");
  });
});
