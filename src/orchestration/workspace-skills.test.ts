/**
 * Tests for workspace-skills-sqlite.ts (Paperclip sync P6)
 *
 * Uses an in-memory SQLite DB with full migrations applied.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../infra/state-db/schema.js";
import { requireNodeSqlite } from "../memory/sqlite.js";

// ── DB mock (must be declared before store imports) ───────────────────

type TestDb = ReturnType<typeof requireNodeSqlite>["DatabaseSync"]["prototype"];
let testDb: TestDb;

vi.mock("../infra/state-db/index.js", () => ({
  getStateDb: () => testDb,
}));

// ── Store imports (hoisted after mock) ────────────────────────────────

import {
  createWorkspaceSkill,
  getWorkspaceSkill,
  getWorkspaceSkillByKey,
  listWorkspaceSkills,
  listWorkspaceSkillsWithCounts,
  updateWorkspaceSkill,
  deleteWorkspaceSkill,
} from "./workspace-skills-sqlite.js";

// ── Fixtures ──────────────────────────────────────────────────────────

const WS_ID = "ws-skills-001";

function makeSkill(key = "my-skill", name = "My Skill") {
  return createWorkspaceSkill({
    workspaceId: WS_ID,
    key,
    slug: key,
    name,
    markdown: "# Skill\nSome content",
    sourceType: "local",
  });
}

// ── Suite ─────────────────────────────────────────────────────────────

describe("workspace-skills-sqlite", () => {
  beforeEach(() => {
    const { DatabaseSync } = requireNodeSqlite();
    testDb = new DatabaseSync(":memory:");
    testDb.exec("PRAGMA journal_mode = WAL");
    testDb.exec("PRAGMA foreign_keys = ON");
    runMigrations(testDb);
  });

  afterEach(() => {
    try {
      testDb.close();
    } catch {
      // ignore
    }
  });

  // ── CRUD ──────────────────────────────────────────────────────────

  describe("CRUD", () => {
    it("createWorkspaceSkill stores key, name, and defaults", () => {
      const s = makeSkill();
      expect(s.key).toBe("my-skill");
      expect(s.name).toBe("My Skill");
      expect(s.trustLevel).toBe("markdown_only");
      expect(s.compatibility).toBe("unknown");
      expect(s.fileInventory).toEqual([]);
      expect(s.metadata).toBeNull();
      expect(s.workspaceId).toBe(WS_ID);
    });

    it("createWorkspaceSkill stores optional fields", () => {
      const s = createWorkspaceSkill({
        workspaceId: WS_ID,
        key: "advanced-skill",
        slug: "advanced-skill",
        name: "Advanced",
        markdown: "# Advanced",
        sourceType: "git",
        description: "A detailed skill",
        sourceLocator: "github.com/org/repo",
        sourceRef: "main",
        trustLevel: "full",
        compatibility: "compatible",
        fileInventory: [{ path: "skill.md", hash: "abc123" }],
        metadata: { version: "1.0" },
      });
      expect(s.description).toBe("A detailed skill");
      expect(s.sourceLocator).toBe("github.com/org/repo");
      expect(s.sourceRef).toBe("main");
      expect(s.trustLevel).toBe("full");
      expect(s.compatibility).toBe("compatible");
      expect(s.fileInventory).toEqual([{ path: "skill.md", hash: "abc123" }]);
      expect(s.metadata).toEqual({ version: "1.0" });
    });

    it("getWorkspaceSkill returns null for unknown id", () => {
      expect(getWorkspaceSkill("nonexistent")).toBeNull();
    });

    it("getWorkspaceSkill returns the created skill by id", () => {
      const s = makeSkill("fetch-skill", "Fetch Skill");
      const fetched = getWorkspaceSkill(s.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.name).toBe("Fetch Skill");
    });

    it("listWorkspaceSkills returns all skills for a workspace", () => {
      makeSkill("skill-a", "Alpha");
      makeSkill("skill-b", "Beta");
      const list = listWorkspaceSkills(WS_ID);
      expect(list).toHaveLength(2);
    });

    it("listWorkspaceSkills returns empty array for unknown workspace", () => {
      makeSkill();
      expect(listWorkspaceSkills("other-ws")).toHaveLength(0);
    });

    it("listWorkspaceSkills orders by name ascending", () => {
      makeSkill("z-skill", "Zebra");
      makeSkill("a-skill", "Alpha");
      const list = listWorkspaceSkills(WS_ID);
      expect(list[0].name).toBe("Alpha");
      expect(list[1].name).toBe("Zebra");
    });

    it("updateWorkspaceSkill changes name and description", () => {
      const s = makeSkill();
      const updated = updateWorkspaceSkill(s.id, { name: "Renamed", description: "New desc" });
      expect(updated.name).toBe("Renamed");
      expect(updated.description).toBe("New desc");
    });

    it("updateWorkspaceSkill changes trustLevel and compatibility", () => {
      const s = makeSkill();
      const updated = updateWorkspaceSkill(s.id, { trustLevel: "full", compatibility: "compatible" });
      expect(updated.trustLevel).toBe("full");
      expect(updated.compatibility).toBe("compatible");
    });

    it("updateWorkspaceSkill updates fileInventory", () => {
      const s = makeSkill();
      const inv = [{ path: "index.ts", hash: "deadbeef" }];
      const updated = updateWorkspaceSkill(s.id, { fileInventory: inv });
      expect(updated.fileInventory).toEqual(inv);
    });

    it("updateWorkspaceSkill clears metadata when set to null", () => {
      const s = createWorkspaceSkill({
        workspaceId: WS_ID,
        key: "meta-skill",
        slug: "meta-skill",
        name: "Meta",
        markdown: "# M",
        sourceType: "local",
        metadata: { foo: "bar" },
      });
      const updated = updateWorkspaceSkill(s.id, { metadata: null });
      expect(updated.metadata).toBeNull();
    });

    it("updateWorkspaceSkill throws for unknown skill", () => {
      expect(() => updateWorkspaceSkill("nonexistent", { name: "x" })).toThrow("WorkspaceSkill not found");
    });

    it("deleteWorkspaceSkill removes the skill", () => {
      const s = makeSkill();
      deleteWorkspaceSkill(s.id);
      expect(getWorkspaceSkill(s.id)).toBeNull();
    });
  });

  // ── getByKey ──────────────────────────────────────────────────────

  describe("getWorkspaceSkillByKey", () => {
    it("returns skill by workspace and key", () => {
      makeSkill("lookup-skill", "Lookup");
      const found = getWorkspaceSkillByKey(WS_ID, "lookup-skill");
      expect(found).not.toBeNull();
      expect(found!.name).toBe("Lookup");
    });

    it("returns null when key does not exist in workspace", () => {
      makeSkill("lookup-skill");
      expect(getWorkspaceSkillByKey(WS_ID, "nonexistent")).toBeNull();
    });

    it("returns null for correct key in wrong workspace", () => {
      makeSkill("lookup-skill");
      expect(getWorkspaceSkillByKey("other-ws", "lookup-skill")).toBeNull();
    });
  });

  // ── Unique constraint ─────────────────────────────────────────────

  describe("unique constraint on (workspace_id, key)", () => {
    it("throws when inserting duplicate key in the same workspace", () => {
      makeSkill("dup-key");
      expect(() => makeSkill("dup-key")).toThrow();
    });

    it("allows same key in different workspaces", () => {
      makeSkill("shared-key");
      expect(() =>
        createWorkspaceSkill({
          workspaceId: "other-ws",
          key: "shared-key",
          slug: "shared-key",
          name: "Other WS Skill",
          markdown: "# Other",
          sourceType: "local",
        }),
      ).not.toThrow();
    });
  });

  // ── listWithCounts ────────────────────────────────────────────────

  describe("listWorkspaceSkillsWithCounts", () => {
    it("returns skills with attachedAgentCount of 0 when no agents attached", () => {
      makeSkill("cnt-skill", "Count Skill");
      const items = listWorkspaceSkillsWithCounts(WS_ID);
      expect(items).toHaveLength(1);
      expect(items[0].attachedAgentCount).toBe(0);
    });

    it("returns empty array for unknown workspace", () => {
      makeSkill();
      expect(listWorkspaceSkillsWithCounts("other-ws")).toHaveLength(0);
    });
  });
});
