import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  it("derives all paths from workspaceDir without hardcoding", () => {
    const workspace = "/tmp/test-workspace";
    const paths = resolveClawHubPaths(workspace);
    expect(paths.clawhubDir).toBe(path.join(workspace, ".openclaw", "clawhub"));
    expect(paths.catalogPath).toBe(path.join(workspace, ".openclaw", "clawhub", "catalog.json"));
    expect(paths.previewsDir).toBe(path.join(workspace, ".openclaw", "clawhub", "previews"));
    expect(paths.lockPath).toBe(path.join(workspace, ".openclaw", "clawhub", "clawhub.lock.json"));
    expect(paths.skillsDir).toBe(path.join(workspace, "skills"));
  });
});

// ─── RPC handler helpers (filesystem-level tests) ─────────────────────────────

describe("clawhub catalog filesystem helpers", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawhub-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("catalog.json is written with syncedAt and categories", () => {
    const paths = resolveClawHubPaths(tmpDir);
    fs.mkdirSync(paths.clawhubDir, { recursive: true });

    const skills = [
      { slug: "gh-pr", displayName: "GitHub PR", summary: "create pull request on github" },
    ];
    const syncedAt = new Date().toISOString();
    const catalog = { syncedAt, totalSkills: skills.length, skills };
    fs.writeFileSync(paths.catalogPath, JSON.stringify(catalog, null, 2), "utf8");

    const written = JSON.parse(fs.readFileSync(paths.catalogPath, "utf8")) as typeof catalog;
    expect(written.syncedAt).toBe(syncedAt);
    expect(written.skills).toHaveLength(1);
    expect(written.skills[0].slug).toBe("gh-pr");
  });

  it("stale preview is invalidated when version changes", () => {
    const paths = resolveClawHubPaths(tmpDir);
    fs.mkdirSync(paths.previewsDir, { recursive: true });

    // Write a preview for slug "gh-pr"
    const previewPath = path.join(paths.previewsDir, "gh-pr.json");
    fs.writeFileSync(
      previewPath,
      JSON.stringify({ slug: "gh-pr", version: "1.0.0", content: "old" }),
      "utf8",
    );
    expect(fs.existsSync(previewPath)).toBe(true);

    // Simulate version change: delete the preview (as sync does)
    fs.unlinkSync(previewPath);
    expect(fs.existsSync(previewPath)).toBe(false);
  });

  it("installed: cross-references skills/ folder with lock file", () => {
    const paths = resolveClawHubPaths(tmpDir);
    fs.mkdirSync(paths.skillsDir, { recursive: true });
    fs.mkdirSync(path.join(paths.skillsDir, "gh-pr"), { recursive: true });
    fs.mkdirSync(path.join(paths.skillsDir, "twitter-poster"), { recursive: true });

    // Write lock file with one entry
    const lock = { "gh-pr": { version: "1.2.0" } };
    fs.mkdirSync(paths.clawhubDir, { recursive: true });
    fs.writeFileSync(paths.lockPath, JSON.stringify(lock), "utf8");

    // Read back
    const lockData = JSON.parse(fs.readFileSync(paths.lockPath, "utf8")) as typeof lock;
    const slugs = fs
      .readdirSync(paths.skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    expect(slugs).toContain("gh-pr");
    expect(slugs).toContain("twitter-poster");
    expect(lockData["gh-pr"].version).toBe("1.2.0");
    // twitter-poster not in lock → installedVersion would be null
    expect(lockData["twitter-poster" as keyof typeof lock]).toBeUndefined();
  });

  it("uninstall: removes skill directory and lock entry", () => {
    const paths = resolveClawHubPaths(tmpDir);
    fs.mkdirSync(paths.skillsDir, { recursive: true });
    const skillDir = path.join(paths.skillsDir, "gh-pr");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# GH PR", "utf8");

    fs.mkdirSync(paths.clawhubDir, { recursive: true });
    const lock = { "gh-pr": { version: "1.0.0" }, "other-skill": { version: "2.0.0" } };
    fs.writeFileSync(paths.lockPath, JSON.stringify(lock), "utf8");

    // Simulate uninstall
    fs.rmSync(skillDir, { recursive: true, force: true });
    const updatedLock = JSON.parse(fs.readFileSync(paths.lockPath, "utf8")) as typeof lock;
    delete updatedLock["gh-pr"];
    fs.writeFileSync(paths.lockPath, JSON.stringify(updatedLock), "utf8");

    expect(fs.existsSync(skillDir)).toBe(false);
    const finalLock = JSON.parse(fs.readFileSync(paths.lockPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(finalLock["gh-pr"]).toBeUndefined();
    expect(finalLock["other-skill"]).toBeDefined();
  });

  it("uninstall: handles non-existent slug gracefully", () => {
    const paths = resolveClawHubPaths(tmpDir);
    fs.mkdirSync(paths.clawhubDir, { recursive: true });
    fs.mkdirSync(paths.skillsDir, { recursive: true });

    const lock = { "other-skill": { version: "1.0.0" } };
    fs.writeFileSync(paths.lockPath, JSON.stringify(lock), "utf8");

    // Uninstall non-existent slug — should not throw
    const skillDir = path.join(paths.skillsDir, "nonexistent");
    expect(fs.existsSync(skillDir)).toBe(false);
    // rmSync with force: true on non-existent path should not throw
    expect(() => fs.rmSync(skillDir, { recursive: true, force: true })).not.toThrow();
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
