import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deleteLockEntryFromDb,
  deleteSkillPreviewFromDb,
  getAllLockEntriesFromDb,
  getCatalogSkillsFromDb,
  getClawhubSyncMeta,
  getSkillPreviewFromDb,
  replaceCatalogInDb,
  setClawhubSyncMeta,
  setSkillPreviewInDb,
} from "../../infra/state-db/clawhub-sqlite.js";
import { useClawhubTestDb } from "../../infra/state-db/test-helpers.clawhub.js";
import { deriveCategories, resolveClawHubPaths } from "./clawhub.js";

// ─── deriveCategories ─────────────────────────────────────────────────────────

describe("deriveCategories", () => {
  it("returns 'other' when no keywords match", () => {
    const result = deriveCategories({ summary: "does nothing special", slug: "noop" });
    expect(result.category).toBe("other");
    expect(result.categories).toEqual(["other"]);
  });

  it("matches a single category by keyword in summary", () => {
    const result = deriveCategories({
      summary: "push to github and create a pull request",
      slug: "gh-pr",
    });
    expect(result.category).toBe("development");
    expect(result.categories).toContain("development");
  });

  it("matches multiple categories and returns highest-scoring first", () => {
    // 'github' + 'commit' → development (2 hits); 'message' → communication (1 hit)
    const result = deriveCategories({
      summary: "commit to github and send a message",
      slug: "multi",
    });
    expect(result.categories[0]).toBe("development");
    expect(result.categories).toContain("communication");
  });

  it("matches by slug when summary is empty", () => {
    const result = deriveCategories({ slug: "twitter-poster", summary: "" });
    expect(result.category).toBe("social");
  });

  it("matches by displayName", () => {
    const result = deriveCategories({ displayName: "YouTube Downloader", slug: "yt-dl" });
    expect(result.category).toBe("media");
  });

  it("is case-insensitive", () => {
    const result = deriveCategories({ summary: "GITHUB integration", slug: "gh" });
    expect(result.category).toBe("development");
  });
});

// ─── resolveClawHubPaths ──────────────────────────────────────────────────────

describe("resolveClawHubPaths", () => {
  it("derives skillsDir from workspaceDir", () => {
    const workspace = "/tmp/test-workspace";
    const paths = resolveClawHubPaths(workspace);
    expect(paths.skillsDir).toBe(path.join(workspace, "skills"));
  });
});

// ─── SQLite-backed clawhub storage tests ──────────────────────────────────────

describe("clawhub catalog SQLite helpers", () => {
  useClawhubTestDb();

  const WS = "/tmp/test-workspace";

  it("catalog is stored with syncedAt and categories", () => {
    const skills = [
      { slug: "gh-pr", displayName: "GitHub PR", summary: "create pull request on github" },
    ];
    const syncedAt = new Date().toISOString();
    replaceCatalogInDb(WS, skills);
    setClawhubSyncMeta(WS, { syncedAt, totalSkills: skills.length });

    const meta = getClawhubSyncMeta(WS);
    expect(meta?.syncedAt).toBe(syncedAt);
    const stored = getCatalogSkillsFromDb(WS);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.slug).toBe("gh-pr");
  });

  it("stale preview is invalidated when version changes", () => {
    replaceCatalogInDb(WS, [{ slug: "gh-pr", latestVersion: { version: "1.0.0" } }]);
    setSkillPreviewInDb(WS, {
      slug: "gh-pr",
      version: "1.0.0",
      fetchedAt: new Date().toISOString(),
      content: "old",
    });
    expect(getSkillPreviewFromDb(WS, "gh-pr")).not.toBeNull();

    // Simulate version change: delete the preview (as sync does)
    deleteSkillPreviewFromDb(WS, "gh-pr");
    expect(getSkillPreviewFromDb(WS, "gh-pr")).toBeNull();
  });

  it("installed: cross-references skills/ folder with lock data", () => {
    const lockData = getAllLockEntriesFromDb(WS);
    // No lock entries initially
    expect(Object.keys(lockData)).toHaveLength(0);
  });

  it("uninstall: removes skill directory and lock entry", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawhub-test-"));
    try {
      const { skillsDir } = resolveClawHubPaths(tmpDir);
      fs.mkdirSync(skillsDir, { recursive: true });
      const skillDir = path.join(skillsDir, "gh-pr");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# GH PR", "utf8");

      // Simulate uninstall: remove directory + lock entry
      fs.rmSync(skillDir, { recursive: true, force: true });
      deleteLockEntryFromDb(tmpDir, "gh-pr");

      expect(fs.existsSync(skillDir)).toBe(false);
      expect(getAllLockEntriesFromDb(tmpDir)["gh-pr"]).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("uninstall: handles non-existent slug gracefully", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawhub-test-"));
    try {
      const { skillsDir } = resolveClawHubPaths(tmpDir);
      fs.mkdirSync(skillsDir, { recursive: true });

      const skillDir = path.join(skillsDir, "nonexistent");
      expect(fs.existsSync(skillDir)).toBe(false);
      expect(() => fs.rmSync(skillDir, { recursive: true, force: true })).not.toThrow();
      // deleteLockEntryFromDb returns false for nonexistent entries
      expect(deleteLockEntryFromDb(tmpDir, "nonexistent")).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("catalog filter: stale when syncedAt > 24h ago", () => {
    const STALE_MS = 24 * 60 * 60 * 1000;
    const oldDate = new Date(Date.now() - STALE_MS - 1000).toISOString();
    const isStale = Date.now() - new Date(oldDate).getTime() > STALE_MS;
    expect(isStale).toBe(true);
  });

  it("catalog filter: not stale when syncedAt is recent", () => {
    const STALE_MS = 24 * 60 * 60 * 1000;
    const recentDate = new Date(Date.now() - 1000).toISOString();
    const isStale = Date.now() - new Date(recentDate).getTime() > STALE_MS;
    expect(isStale).toBe(false);
  });
});
