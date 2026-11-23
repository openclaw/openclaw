import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateCandidateChangelog } from "../../scripts/lib/release-candidate-changelog.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { fixtureGit } from "./release-publish.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const checker = resolve("scripts/check-changelog-attributions.mts");
const version = "2026.8.1";
const clean = "- Fixes: keep replies threaded. Thanks @steipete.";
const bad = "- Fixes: keep replies threaded. Thanks @codex.";

function createFixture(selectedVersion = version, split = true) {
  const root = tempDirs.make("openclaw-selected-changelog-");
  const git = fixtureGit(root, "Release Fixture", "release-fixture@example.com", true);
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  git("init", "-q", "--initial-branch=main");
  git("commit", "--allow-empty", "-qm", "seed history");
  const seed = git("rev-parse", "HEAD");
  const record = (text: string) =>
    `## ${selectedVersion}\n\n### Complete contribution record\n\n` +
    `This audited record covers the complete ${seed}..${seed} history: 1 merged PR.\n\n#### Pull requests\n\n- **PR #123** ${text}\n`;
  const historical = "## 2026.7.1\n\n" + bad + "\n";
  const writeSelected = (notes = clean, credit = clean, mirror = false) => {
    const frozen = record(credit);
    const marker = mirror ? "<!-- openclaw-docs-mirror-v1 -->\n\n" : "";
    const contribution = mirror ? "" : frozen.slice(frozen.indexOf("### Complete"));
    const section = `## ${selectedVersion}\n\n${marker}${notes}\n\n${contribution}`;
    if (split) {
      write("CHANGELOG.md", "# Changelog\n\n<!-- openclaw:split-changelog -->\n");
      write("CHANGELOG/2026.7.1.md", historical);
      write("CHANGELOG/" + selectedVersion + ".md", section);
      write("CHANGELOG/records/" + selectedVersion + ".md", frozen);
    } else {
      write("CHANGELOG.md", "# Changelog\n\n" + section + "\n" + historical);
    }
  };
  const commit = () => {
    git("add", ".");
    git("commit", "-qm", "freeze notes");
    return git("rev-parse", "HEAD");
  };
  writeSelected();
  const targetSha = commit();
  const validate = (tag = "v" + selectedVersion, target = targetSha) => {
    // The production caller runs in its target repository for ancestry checks.
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    try {
      const input = { rootDir: root, repository: "openclaw/openclaw", tag, targetSha: target };
      return validateCandidateChangelog(input);
    } finally {
      cwd.mockRestore();
    }
  };
  return { root, git, write, writeSelected, commit, targetSha, validate };
}

describe("candidate publication changelog scope", () => {
  it.each([true, false])("ignores archived bot credits with split=%s", (split) => {
    const f = createFixture(version, split);
    const result = f.validate();
    expect(result.releaseNotesCheck.status).toBe("passed");
    expect(result.releaseNotesProvenance.status).toBe("passed");
    const lint = spawnSync(process.execPath, [checker], { cwd: f.root, encoding: "utf8" });
    expect(lint.status, lint.stderr).toBe(1);
    expect(lint.stderr).toContain(
      split ? "CHANGELOG/2026.7.1.md:3 uses Thanks @codex" : "uses Thanks @codex",
    );
  });

  it.each([true, false])("rejects selected notes bot credits with split=%s", (split) => {
    const f = createFixture(version, split);
    f.writeSelected(bad);
    const target = f.commit();
    expect(() => f.validate(undefined, target)).toThrow(
      split ? `CHANGELOG/${version}.md:3 uses Thanks @codex` : "CHANGELOG.md:3 uses Thanks @codex",
    );
  });

  it("rejects bot credits in the selected frozen record before rendering", () => {
    const f = createFixture();
    f.writeSelected(clean, bad, true);
    const target = f.commit();
    expect(() => f.validate(undefined, target)).toThrow(
      `CHANGELOG/records/${version}.md:9 uses Thanks @codex`,
    );
  });

  it.each(["2026.8.1-beta.2", "2026.8.1-1"])("selects dedicated %s notes", (selected) => {
    const f = createFixture(selected);
    f.write("CHANGELOG/" + version + ".md", "## " + version + "\n\n" + bad + "\n");
    const target = f.commit();
    expect(f.validate("v" + selected, target).releaseNotesCheck.status).toBe("passed");
    f.writeSelected(bad);
    const rejected = f.commit();
    expect(() => f.validate("v" + selected, rejected)).toThrow(
      `CHANGELOG/${selected}.md:3 uses Thanks @codex`,
    );
  });

  it("preserves correction fallback to legacy base notes", () => {
    const result = createFixture(version, false).validate("v2026.8.1-1");
    expect(result.releaseNotesCheck.status).toBe("passed");
  });

  it("preserves rejection of beta notes without a dedicated heading", () => {
    expect(() => createFixture(version, false).validate("v2026.8.1-beta.2")).toThrow(
      "does not contain ## 2026.8.1-beta.2",
    );
  });

  it("reads the immutable target rather than HEAD or dirty worktree notes", () => {
    const f = createFixture();
    f.writeSelected(bad);
    const badTarget = f.commit();
    f.writeSelected(clean);
    expect(f.validate().releaseNotesCheck.status).toBe("passed");
    expect(() => f.validate(undefined, badTarget)).toThrow(
      `CHANGELOG/${version}.md:3 uses Thanks @codex`,
    );
  });
});
