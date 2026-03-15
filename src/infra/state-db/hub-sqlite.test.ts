import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteHubInstalledFromDb,
  getAllHubInstalledFromDb,
  getHubCatalogItemFromDb,
  getHubCatalogItemsFromDb,
  getHubCollectionsFromDb,
  getHubInstalledItemFromDb,
  getHubSyncMeta,
  insertHubInstalledInDb,
  markHubItemsBundledInDb,
  replaceHubCatalogInDb,
  replaceHubCollectionsInDb,
  resetHubDbForTest,
  setHubDbForTest,
  setHubSyncMeta,
} from "./hub-sqlite.js";
import { runMigrations } from "./schema.js";

function makeTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  return db;
}

describe("hub-sqlite", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = makeTestDb();
    setHubDbForTest(db);
  });

  afterEach(() => {
    resetHubDbForTest();
    db.close();
  });

  // ── Sync meta ──────────────────────────────────────────────────────────────

  describe("sync meta", () => {
    it("returns null when no sync has been performed", () => {
      expect(getHubSyncMeta()).toBeNull();
    });

    it("persists and retrieves sync metadata", () => {
      const meta = { syncedAt: "2026-03-15T00:00:00Z", totalItems: 10 };
      setHubSyncMeta(meta);
      expect(getHubSyncMeta()).toEqual(meta);
    });

    it("overwrites existing sync metadata on second call", () => {
      setHubSyncMeta({ syncedAt: "2026-03-14T00:00:00Z", totalItems: 5 });
      setHubSyncMeta({ syncedAt: "2026-03-15T00:00:00Z", totalItems: 10 });
      expect(getHubSyncMeta()?.totalItems).toBe(10);
    });
  });

  // ── Catalog ────────────────────────────────────────────────────────────────

  const sampleItems = [
    {
      slug: "code-reviewer",
      name: "Code Reviewer",
      type: "skill" as const,
      category: "engineering",
      description: "Thorough code review",
      path: "skills/code-reviewer/SKILL.md",
      readme: "skills/code-reviewer/README.md",
      version: "1.0.0",
      tags: ["code-quality", "review"],
      emoji: "🔍",
      sha256: "abc123",
      bundled: false,
    },
    {
      slug: "security-engineer",
      name: "Security Engineer",
      type: "agent" as const,
      category: "engineering",
      description: "OWASP security engineer",
      path: "agents/security-engineer.md",
      readme: null,
      version: "1.0.0",
      tags: ["security"],
      emoji: "🔒",
      sha256: "def456",
      bundled: false,
    },
    {
      slug: "review-pr",
      name: "Review PR",
      type: "command" as const,
      category: "engineering",
      description: "Review a PR",
      path: "commands/review-pr.md",
      readme: null,
      version: "1.0.0",
      tags: ["pr", "review"],
      emoji: "👀",
      sha256: null,
      bundled: false,
    },
  ];

  describe("catalog", () => {
    it("returns empty array when catalog is empty", () => {
      expect(getHubCatalogItemsFromDb()).toEqual([]);
    });

    it("inserts and retrieves catalog items", () => {
      replaceHubCatalogInDb(sampleItems);
      const items = getHubCatalogItemsFromDb();
      expect(items).toHaveLength(3);
    });

    it("retrieves a single item by slug", () => {
      replaceHubCatalogInDb(sampleItems);
      const item = getHubCatalogItemFromDb("code-reviewer");
      expect(item?.name).toBe("Code Reviewer");
      expect(item?.type).toBe("skill");
      expect(item?.tags).toContain("code-quality");
    });

    it("returns null for unknown slug", () => {
      replaceHubCatalogInDb(sampleItems);
      expect(getHubCatalogItemFromDb("unknown-slug")).toBeNull();
    });

    it("filters by type", () => {
      replaceHubCatalogInDb(sampleItems);
      const skills = getHubCatalogItemsFromDb({ type: "skill" });
      expect(skills).toHaveLength(1);
      expect(skills[0].slug).toBe("code-reviewer");
    });

    it("filters by category", () => {
      replaceHubCatalogInDb(sampleItems);
      const items = getHubCatalogItemsFromDb({ category: "engineering" });
      expect(items).toHaveLength(3);
    });

    it("replaces catalog on second call (no duplicates)", () => {
      replaceHubCatalogInDb(sampleItems);
      replaceHubCatalogInDb(sampleItems.slice(0, 1));
      expect(getHubCatalogItemsFromDb()).toHaveLength(1);
    });

    it("preserves bundled flags on catalog replacement", () => {
      replaceHubCatalogInDb(sampleItems);
      markHubItemsBundledInDb(new Set(["security-engineer"]));
      // Replace catalog again — bundled flag should be preserved
      replaceHubCatalogInDb(sampleItems);
      const agent = getHubCatalogItemFromDb("security-engineer");
      expect(agent?.bundled).toBe(true);
    });
  });

  describe("markHubItemsBundledInDb", () => {
    it("marks specified agent slugs as bundled", () => {
      replaceHubCatalogInDb(sampleItems);
      markHubItemsBundledInDb(new Set(["security-engineer"]));
      expect(getHubCatalogItemFromDb("security-engineer")?.bundled).toBe(true);
      expect(getHubCatalogItemFromDb("code-reviewer")?.bundled).toBe(false);
    });

    it("no-ops on empty set", () => {
      replaceHubCatalogInDb(sampleItems);
      markHubItemsBundledInDb(new Set());
      expect(getHubCatalogItemsFromDb().every((i) => !i.bundled)).toBe(true);
    });
  });

  // ── Installed ──────────────────────────────────────────────────────────────

  describe("installed tracking", () => {
    it("returns empty array when nothing installed", () => {
      expect(getAllHubInstalledFromDb()).toEqual([]);
    });

    it("inserts and retrieves installed item", () => {
      insertHubInstalledInDb({
        slug: "code-reviewer",
        type: "skill",
        version: "1.0.0",
        installPath: "/home/user/.openclaw/workspace-default/skills/code-reviewer/SKILL.md",
        agentId: "default",
      });
      const item = getHubInstalledItemFromDb("code-reviewer");
      expect(item?.slug).toBe("code-reviewer");
      expect(item?.version).toBe("1.0.0");
    });

    it("returns null for uninstalled slug", () => {
      expect(getHubInstalledItemFromDb("not-installed")).toBeNull();
    });

    it("deletes installed item", () => {
      insertHubInstalledInDb({
        slug: "code-reviewer",
        type: "skill",
        version: "1.0.0",
        installPath: "/tmp/SKILL.md",
        agentId: "default",
      });
      expect(deleteHubInstalledFromDb("code-reviewer")).toBe(true);
      expect(getHubInstalledItemFromDb("code-reviewer")).toBeNull();
    });

    it("returns false when deleting non-existent item", () => {
      expect(deleteHubInstalledFromDb("not-installed")).toBe(false);
    });

    it("upserts on duplicate slug", () => {
      insertHubInstalledInDb({
        slug: "code-reviewer",
        type: "skill",
        version: "1.0.0",
        installPath: "/tmp/v1.md",
        agentId: "default",
      });
      insertHubInstalledInDb({
        slug: "code-reviewer",
        type: "skill",
        version: "2.0.0",
        installPath: "/tmp/v2.md",
        agentId: "default",
      });
      const item = getHubInstalledItemFromDb("code-reviewer");
      expect(item?.version).toBe("2.0.0");
      expect(getAllHubInstalledFromDb()).toHaveLength(1);
    });

    it("lists all installed items", () => {
      insertHubInstalledInDb({
        slug: "code-reviewer",
        type: "skill",
        version: "1.0.0",
        installPath: "/tmp/SKILL.md",
        agentId: "default",
      });
      insertHubInstalledInDb({
        slug: "review-pr",
        type: "command",
        version: "1.0.0",
        installPath: "/tmp/review-pr.md",
        agentId: null,
      });
      expect(getAllHubInstalledFromDb()).toHaveLength(2);
    });
  });

  // ── Collections ────────────────────────────────────────────────────────────

  describe("collections", () => {
    const sampleCollections = [
      {
        slug: "engineering-essentials",
        name: "Engineering Essentials",
        description: "Core engineering pack",
        emoji: "⚡",
        items: ["code-reviewer", "security-engineer"],
      },
      {
        slug: "devops-starter",
        name: "DevOps Starter",
        description: null,
        emoji: "🚀",
        items: ["review-pr"],
      },
    ];

    it("returns empty array when no collections", () => {
      expect(getHubCollectionsFromDb()).toEqual([]);
    });

    it("inserts and retrieves collections", () => {
      replaceHubCollectionsInDb(sampleCollections);
      const cols = getHubCollectionsFromDb();
      expect(cols).toHaveLength(2);
    });

    it("preserves item slugs array", () => {
      replaceHubCollectionsInDb(sampleCollections);
      const col = getHubCollectionsFromDb().find((c) => c.slug === "engineering-essentials");
      expect(col?.items).toEqual(["code-reviewer", "security-engineer"]);
    });

    it("replaces collections on second call", () => {
      replaceHubCollectionsInDb(sampleCollections);
      replaceHubCollectionsInDb(sampleCollections.slice(0, 1));
      expect(getHubCollectionsFromDb()).toHaveLength(1);
    });
  });
});
