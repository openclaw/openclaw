/**
 * Tests for portability-store-sqlite.ts (Paperclip sync P6)
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
  createPortabilityExport,
  getPortabilityExport,
  listPortabilityExports,
  updatePortabilityExport,
  createPortabilityImport,
  getPortabilityImport,
  listPortabilityImports,
  updatePortabilityImport,
} from "./portability-store-sqlite.js";

// ── Fixtures ──────────────────────────────────────────────────────────

const WS_ID = "ws-portability-001";

function makeExport(workspaceId = WS_ID) {
  return createPortabilityExport({
    workspaceId,
    include: { routines: true, skills: false, goals: false },
  });
}

function makeImport(workspaceId = WS_ID) {
  return createPortabilityImport({ workspaceId });
}

// ── Suite ─────────────────────────────────────────────────────────────

describe("portability-store-sqlite", () => {
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

  // ── Portability Exports ───────────────────────────────────────────

  describe("portability exports", () => {
    it("createPortabilityExport stores include and defaults to pending status", () => {
      const e = makeExport();
      expect(e.status).toBe("pending");
      expect(e.workspaceId).toBe(WS_ID);
      expect(e.include).toEqual({ routines: true, skills: false, goals: false });
      expect(e.assetPath).toBeNull();
      expect(e.error).toBeNull();
      expect(e.completedAt).toBeNull();
      expect(e.exportedBy).toBeNull();
    });

    it("createPortabilityExport stores exportedBy", () => {
      const e = createPortabilityExport({
        workspaceId: WS_ID,
        include: { routines: false, skills: true, goals: true },
        exportedBy: "user-123",
      });
      expect(e.exportedBy).toBe("user-123");
    });

    it("getPortabilityExport returns null for unknown id", () => {
      expect(getPortabilityExport("nonexistent")).toBeNull();
    });

    it("getPortabilityExport returns export by id", () => {
      const e = makeExport();
      const fetched = getPortabilityExport(e.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(e.id);
    });

    it("listPortabilityExports returns all exports for a workspace", () => {
      makeExport();
      makeExport();
      expect(listPortabilityExports(WS_ID)).toHaveLength(2);
    });

    it("listPortabilityExports returns empty array for unknown workspace", () => {
      makeExport();
      expect(listPortabilityExports("other-ws")).toHaveLength(0);
    });

    it("listPortabilityExports without workspaceId returns all exports", () => {
      makeExport(WS_ID);
      makeExport("ws-other");
      expect(listPortabilityExports()).toHaveLength(2);
    });

    it("updatePortabilityExport transitions status to completed", () => {
      const e = makeExport();
      const completedAt = Math.floor(Date.now() / 1000);
      const updated = updatePortabilityExport(e.id, {
        status: "completed",
        assetPath: "/exports/bundle.zip",
        completedAt,
      });
      expect(updated.status).toBe("completed");
      expect(updated.assetPath).toBe("/exports/bundle.zip");
      expect(updated.completedAt).toBe(completedAt);
    });

    it("updatePortabilityExport transitions status to failed with error", () => {
      const e = makeExport();
      const updated = updatePortabilityExport(e.id, {
        status: "failed",
        error: "disk full",
        completedAt: Math.floor(Date.now() / 1000),
      });
      expect(updated.status).toBe("failed");
      expect(updated.error).toBe("disk full");
    });

    it("updatePortabilityExport with no updates returns existing export unchanged", () => {
      const e = makeExport();
      const unchanged = updatePortabilityExport(e.id, {});
      expect(unchanged.status).toBe("pending");
    });

    it("updatePortabilityExport throws for unknown export", () => {
      expect(() => updatePortabilityExport("nonexistent", { status: "completed" })).toThrow(
        "PortabilityExport not found",
      );
    });
  });

  // ── Portability Imports ───────────────────────────────────────────

  describe("portability imports", () => {
    it("createPortabilityImport stores defaults", () => {
      const i = makeImport();
      expect(i.status).toBe("pending");
      expect(i.workspaceId).toBe(WS_ID);
      expect(i.collisionStrategy).toBe("skip");
      expect(i.result).toBeNull();
      expect(i.error).toBeNull();
      expect(i.completedAt).toBeNull();
      expect(i.importedBy).toBeNull();
      expect(i.sourceRef).toBeNull();
    });

    it("createPortabilityImport stores optional fields", () => {
      const i = createPortabilityImport({
        workspaceId: WS_ID,
        sourceRef: "s3://bucket/export.zip",
        collisionStrategy: "overwrite",
        importedBy: "agent-xyz",
      });
      expect(i.sourceRef).toBe("s3://bucket/export.zip");
      expect(i.collisionStrategy).toBe("overwrite");
      expect(i.importedBy).toBe("agent-xyz");
    });

    it("getPortabilityImport returns null for unknown id", () => {
      expect(getPortabilityImport("nonexistent")).toBeNull();
    });

    it("getPortabilityImport returns import by id", () => {
      const i = makeImport();
      const fetched = getPortabilityImport(i.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(i.id);
    });

    it("listPortabilityImports returns all imports for a workspace", () => {
      makeImport();
      makeImport();
      expect(listPortabilityImports(WS_ID)).toHaveLength(2);
    });

    it("listPortabilityImports returns empty array for unknown workspace", () => {
      makeImport();
      expect(listPortabilityImports("other-ws")).toHaveLength(0);
    });

    it("listPortabilityImports without workspaceId returns all imports", () => {
      makeImport(WS_ID);
      makeImport("ws-other");
      expect(listPortabilityImports()).toHaveLength(2);
    });

    it("updatePortabilityImport transitions status to completed with result", () => {
      const i = makeImport();
      const completedAt = Math.floor(Date.now() / 1000);
      const result = { imported: 5, skipped: 2, errors: 0 };
      const updated = updatePortabilityImport(i.id, { status: "completed", result, completedAt });
      expect(updated.status).toBe("completed");
      expect(updated.result).toEqual(result);
      expect(updated.completedAt).toBe(completedAt);
    });

    it("updatePortabilityImport transitions status to failed with error", () => {
      const i = makeImport();
      const updated = updatePortabilityImport(i.id, {
        status: "failed",
        error: "invalid archive",
        completedAt: Math.floor(Date.now() / 1000),
      });
      expect(updated.status).toBe("failed");
      expect(updated.error).toBe("invalid archive");
    });

    it("updatePortabilityImport clears result when set to null", () => {
      const i = makeImport();
      updatePortabilityImport(i.id, { result: { count: 1 } });
      const cleared = updatePortabilityImport(i.id, { result: null });
      expect(cleared.result).toBeNull();
    });

    it("updatePortabilityImport with no updates returns existing import unchanged", () => {
      const i = makeImport();
      const unchanged = updatePortabilityImport(i.id, {});
      expect(unchanged.status).toBe("pending");
    });

    it("updatePortabilityImport throws for unknown import", () => {
      expect(() => updatePortabilityImport("nonexistent", { status: "completed" })).toThrow(
        "PortabilityImport not found",
      );
    });
  });
});
