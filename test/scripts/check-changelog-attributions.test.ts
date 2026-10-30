import { spawnSync } from "node:child_process";
import { symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findForbiddenChangelogThanks,
  isForbiddenChangelogThanksHandle,
  requiresExplicitHumanChangelogThanks,
} from "../../scripts/check-changelog-attributions.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { fixtureGit } from "./release-publish.test-support.js";

const tempRoots = useAutoCleanupTempDirTracker(afterEach);
function createRepoWithPrChangelogDiff(entry: string): string {
  const repo = tempRoots.make("openclaw-changelog-credit-");
  const git = fixtureGit(repo, "Test User", "test@example.com");
  git("init", "-q", "--initial-branch=main");
  const header = "# Changelog\n\n## Unreleased\n\n### Fixes\n\n";
  writeFileSync(repo + "/CHANGELOG.md", header, "utf8");
  git("add", "CHANGELOG.md");
  git("commit", "-qm", "seed");
  const baseSha = git("rev-parse", "HEAD");
  // Direct helper callers capture this base as the operation's main snapshot.
  git("update-ref", "refs/remotes/origin/main", baseSha);
  git("checkout", "-qb", "feature");
  writeFileSync(repo + "/CHANGELOG.md", `${header}${entry}\n`, "utf8");
  git("add", "CHANGELOG.md");
  git("commit", "-qm", "add changelog entry");
  return repo;
}

describe("check-changelog-attributions", () => {
  it.each([false, true])("rejects forbidden CLI credit through a symlink: %s", (symlink) => {
    const repo = createRepoWithPrChangelogDiff("- Fix. Thanks @codex.");
    const scripts = path.resolve("scripts");
    const alias = path.join(repo, "script-alias");
    symlinkSync(scripts, alias, "junction");
    const entry = path.join(symlink ? alias : scripts, "check-changelog-attributions.mts");
    const result = spawnSync(process.execPath, [entry], {
      cwd: repo,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Forbidden changelog thanks attribution:");
    expect(result.stderr).toContain("- CHANGELOG.md:7 uses Thanks @codex");
  });

  it("flags forbidden bot, org, and maintainer thanks attributions", () => {
    const handles = [
      "codex",
      "contributor and @OpenClaw",
      "clawsweeper",
      "dependabot[bot]",
      "app/worker",
    ];
    const lines = handles.map((handle) => `- Fix. Thanks @${handle}.`);
    expect(findForbiddenChangelogThanks(lines.join("\n"))).toEqual(
      ["codex", "openclaw", "clawsweeper", "dependabot[bot]", "app/worker"].map(
        (handle, index) => ({ line: index + 1, handle, text: lines[index] }),
      ),
    );
  });

  it("allows maintainer authorship before an external Thanks clause", () => {
    const text = "- Fix. Authored by @steipete. Thanks @external-contributor.";
    expect(findForbiddenChangelogThanks(text)).toStrictEqual([]);
    expect(
      findForbiddenChangelogThanks("- Fix. Thanks @external-contributor and @steipete."),
    ).toHaveLength(1);
  });

  it("allows external contributor thanks attributions", () => {
    const text = "- Fix. Thanks @external-contributor and @human-clawsweeper-fan.";
    expect(findForbiddenChangelogThanks(text)).toStrictEqual([]);
  });

  it("preserves strict bot-handle classification", () => {
    expect(
      ["dependabot[bot]", "human-clawsweeper-fan"].map((handle) =>
        isForbiddenChangelogThanksHandle(handle, { strictBotHandle: true }),
      ),
    ).toEqual([true, false]);
  });
  it.each(["", "null", "codex"])(
    "rejects non-human shell credit without treating %j as a bot",
    (handle) => {
      expect(isForbiddenChangelogThanksHandle(handle)).toBe(true);
      expect(requiresExplicitHumanChangelogThanks(handle)).toBe(false);
    },
  );

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
