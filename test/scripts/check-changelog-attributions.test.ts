import { spawnSync } from "node:child_process";
import fs, { symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findForbiddenChangelogThanks,
  isForbiddenChangelogThanksHandle,
  main,
  requiresExplicitHumanChangelogThanks,
} from "../../scripts/check-changelog-attributions.mts";
import * as directoryWalk from "../../src/infra/directory-walk.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { fixtureGit } from "./release-publish.test-support.js";

const tempRoots = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});
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
  it.each([false, true])("checks Windows changelog paths (frozen=%s)", async (frozen) => {
    const repo = tempRoots.make("openclaw-windows-changelog-");
    const artifact = frozen ? "records/2026.9.4.md" : "2026.9.4.md";
    fs.mkdirSync(path.dirname(path.join(repo, "CHANGELOG", artifact)), { recursive: true });
    writeFileSync(path.join(repo, "CHANGELOG.md"), "# Changelog\n");
    writeFileSync(
      path.join(repo, "CHANGELOG", artifact),
      "<!-- openclaw-docs-mirror-v1 -->\n- Fix. Thanks @steipete.\n",
    );
    const walk = directoryWalk.listDirectoryTreeStrictSync;
    vi.spyOn(directoryWalk, "listDirectoryTreeStrictSync").mockImplementation((root) =>
      walk(root).map((entry) => ({
        dirent: entry.dirent,
        relativePath: path.win32.normalize(entry.relativePath),
      })),
    );
    const relative = path.relative;
    vi.spyOn(path, "relative").mockImplementation((from, to) =>
      path.win32.normalize(relative(from, to)),
    );
    vi.spyOn(process, "cwd").mockReturnValue(repo);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const platform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      await main();
      expect(process.exitCode ?? 0).toBe(frozen ? 1 : 0);
      if (frozen) {
        expect(errors).toHaveBeenCalledWith(`- CHANGELOG/${artifact}:2 uses Thanks @steipete`);
      }
    } finally {
      Object.defineProperty(process, "platform", { value: platform });
    }
  });
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

  it("preserves bot-handle classification", () => {
    expect(
      ["dependabot[bot]", "human-clawsweeper-fan"].map((handle) =>
        isForbiddenChangelogThanksHandle(handle),
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
