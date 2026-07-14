// Covers the SQLite WAL-reset corruption safety floor and diagnostic wording.
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeSharedSqliteFlag } from "./node-sqlite.js";

const originalPrepare = Reflect.get(DatabaseSync.prototype, "prepare") as DatabaseSync["prepare"];

async function loadNodeSqliteWithVersion(version: string) {
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(
    function (this: DatabaseSync, sql) {
      if (sql === "SELECT sqlite_version() AS version") {
        return {
          get: () => ({ version }),
        } as unknown as StatementSync;
      }
      return originalPrepare.call(this, sql);
    },
  );
  return await import("./node-sqlite.js");
}

describe("node SQLite safety", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["3.51.3", "3.51.4", "3.52.0", "4.0.0", "3.50.7", "3.50.8", "3.44.6"])(
    "accepts patched SQLite %s",
    async (version) => {
      const { requireNodeSqlite } = await loadNodeSqliteWithVersion(version);
      expect(() => requireNodeSqlite()).not.toThrow();
    },
  );

  it.each(["3.51.2", "3.51.0", "3.50.6", "3.49.1", "3.44.5", "invalid", "3.51"])(
    "rejects vulnerable or unknown SQLite %s",
    async (version) => {
      const { requireNodeSqlite } = await loadNodeSqliteWithVersion(version);
      // Shared builds insert a parenthetical after the version; match the loaded
      // library version and the WAL-safety clause without requiring "embeds".
      expect(() => requireNodeSqlite()).toThrow(
        new RegExp(`SQLite ${version.replaceAll(".", "\\.")}[\\s\\S]*which is affected`),
      );
    },
  );

  it.each([
    {
      shared: false as NodeSharedSqliteFlag,
      expected: "Node 24.18.0 embeds SQLite 3.46.1",
      forbid: ["shared SQLite"],
    },
    {
      shared: true as NodeSharedSqliteFlag,
      expected:
        "Node 24.18.0 is using shared SQLite 3.46.1 (loaded library; process.versions.sqlite may differ)",
      forbid: ["embeds SQLite"],
    },
    {
      shared: undefined as NodeSharedSqliteFlag,
      expected: "Node 24.18.0 is using SQLite 3.46.1",
      forbid: ["embeds SQLite", "shared SQLite"],
    },
    {
      shared: 1 as NodeSharedSqliteFlag,
      expected:
        "Node 24.18.0 is using shared SQLite 3.46.1 (loaded library; process.versions.sqlite may differ)",
      forbid: ["embeds SQLite"],
    },
    {
      shared: 0 as NodeSharedSqliteFlag,
      expected: "Node 24.18.0 embeds SQLite 3.46.1",
      forbid: ["shared SQLite"],
    },
    {
      shared: "true" as NodeSharedSqliteFlag,
      expected:
        "Node 24.18.0 is using shared SQLite 3.46.1 (loaded library; process.versions.sqlite may differ)",
      forbid: ["embeds SQLite"],
    },
    {
      shared: "false" as NodeSharedSqliteFlag,
      expected: "Node 24.18.0 embeds SQLite 3.46.1",
      forbid: ["shared SQLite"],
    },
  ])("describeLoadedSqliteRuntime for sharedFlag=$shared", async ({ shared, expected, forbid }) => {
    const { describeLoadedSqliteRuntime } = await import("./node-sqlite.js");
    const text = describeLoadedSqliteRuntime("3.46.1", "24.18.0", shared);
    expect(text).toBe(expected);
    for (const fragment of forbid) {
      expect(text).not.toContain(fragment);
    }
  });

  it("rejects using host linkage wording without claiming embeds on shared builds", async () => {
    const { requireNodeSqlite, readNodeSharedSqliteFlag, normalizeNodeSharedSqliteFlag } =
      await loadNodeSqliteWithVersion("3.46.1");
    let message = "";
    try {
      requireNodeSqlite();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/SQLite 3\.46\.1[\s\S]*which is affected/);
    const shared = normalizeNodeSharedSqliteFlag(readNodeSharedSqliteFlag());
    if (shared === true) {
      expect(message).toContain("shared SQLite 3.46.1");
      expect(message).not.toContain("embeds SQLite");
    } else if (shared === false) {
      expect(message).toContain("embeds SQLite 3.46.1");
    } else {
      expect(message).toContain("is using SQLite 3.46.1");
      expect(message).not.toContain("embeds SQLite");
    }
  });

  it("accepts the SQLite build in the supported test runtime", () => {
    return import("./node-sqlite.js").then(({ requireNodeSqlite }) => {
      expect(() => requireNodeSqlite()).not.toThrow();
    });
  });
});
