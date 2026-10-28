import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isEligibleHandle } from "../../.agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs";
import {
  findForbiddenChangelogThanks,
  findChangelogAttributionViolations,
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

  it("flags forbidden bot and organization thanks attributions", () => {
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

describe("uniform genuine-human attribution", () => {
  const surfaces = [
    ["initial", "CHANGELOG/2026.10.9.md", ""],
    ["frozen", "CHANGELOG/records/2026.10.9.md", ""],
    ["docs mirror", "CHANGELOG/2026.10.9.md", "<!-- openclaw-docs-mirror-v1 -->\n"],
  ];
  it.each(surfaces)("retains genuine human credit in %s", (_name, file, prefix) => {
    expect(
      findChangelogAttributionViolations([
        { path: file, content: prefix + "- Fix. Thanks @Steipete." },
      ]),
    ).toEqual([]);
    expect(isEligibleHandle("Steipete")).toBe(true);
  });
  it.each(surfaces)("rejects automation credit in %s", (_name, file, prefix) => {
    expect(
      findChangelogAttributionViolations([
        { path: file, content: prefix + "- Fix. Thanks @steipete-oai." },
      ]),
    ).toMatchObject([{ path: file, handle: "steipete-oai" }]);
    expect(isEligibleHandle("steipete-oai")).toBe(false);
  });
  it.each([
    ["steipete", 1, 1],
    ["Steipete", 1, 1],
    ["steipete-oai", 0, 0],
    ["STEIPETE-OAI", 0, 0],
    ["dependabot[bot]", 0, 0],
  ])("uses the same CLI identity policy for %s", (handle, forbidden, explicit) => {
    const script = path.resolve("scripts/check-changelog-attributions.mjs");
    for (const [flag, status] of [
      ["--is-forbidden-handle", forbidden],
      ["--requires-explicit-human-thanks", explicit],
    ] as const) {
      expect(
        spawnSync(process.execPath, [script, flag, handle as string], { encoding: "utf8" }).status,
      ).toBe(status);
    }
  });
  it.each([
    ["steipete", 0],
    ["steipete-oai", 1],
  ])("scans split and frozen files through the real CLI for %s", (handle, status) => {
    const repo = tempRoots.make("openclaw-credit-surfaces-");
    mkdirSync(path.join(repo, "CHANGELOG/records"), { recursive: true });
    writeFileSync(path.join(repo, "CHANGELOG.md"), "# Changelog\n");
    for (const file of ["CHANGELOG/2026.10.9.md", "CHANGELOG/records/2026.10.9.md"]) {
      writeFileSync(path.join(repo, file), "- Fix. Thanks @" + handle + ".\n");
    }
    const result = spawnSync(
      process.execPath,
      [path.resolve("scripts/check-changelog-attributions.mjs"), "CHANGELOG.md"],
      { cwd: repo, encoding: "utf8" },
    );
    expect(result.status, result.stdout + result.stderr).toBe(status);
  });
  it.each([
    ["steipete", "- Human repair (#123). Thanks @steipete.", true],
    ["steipete", "- Human repair (#123).", false],
    ["steipete-oai", "- Bot repair (#123). Thanks @human-author.", true],
    ["steipete-oai", "- Bot repair (#123).", false],
    ["steipete-oai", "- Bot repair (#123). Thanks @steipete-oai.", false],
    ["steipete-oai", "- Bot repair (#123). Thanks @steipete.", true],
  ])("runs integrated PR fallback for %s: %s", (handle, entry, success) => {
    const repo = createRepoWithPrChangelogDiff(entry as string);
    // Match gates.sh: global policy before per-PR human/fallback credit checks.
    const script =
      'set -e; source "$OPENCLAW_PR_CHANGELOG_SH"; PR_MAIN_SHA=$(git rev-parse --verify refs/remotes/origin/main); validate_changelog_attribution_policy; validate_changelog_entry_for_pr 123 "$PR_AUTHOR"';
    const result = spawnSync("bash", ["-c", script], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        PR_AUTHOR: handle as string,
        OPENCLAW_PR_CHANGELOG_SH: path.resolve("scripts/pr-lib/changelog.sh"),
      },
    });
    expect(result.status === 0, result.stdout + result.stderr).toBe(success);
  });
});
