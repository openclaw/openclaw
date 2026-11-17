import { expect, it, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import * as admission from "../../infra/sqlite-database-admission.js";
import { readModelContextNavigationPages } from "./session-model-context-pages.js";
import type { ContextEntry } from "./session-model-context-window.js";

it("reads page receipts only for occupied sparse navigation pages", () => {
  using database = openNodeSqliteDatabase(":memory:");
  const entries: ContextEntry[] = [
    {
      type: "message",
      id: "first",
      parentId: null,
      seq: 1,
      timestamp: new Date(1).toISOString(),
      message: { role: "user", content: "first", timestamp: 1 },
    },
    {
      type: "message",
      id: "last",
      parentId: "first",
      seq: 4_000_000,
      timestamp: new Date(2).toISOString(),
      message: { role: "user", content: "last", timestamp: 2 },
    },
  ];
  const receipts = vi.spyOn(admission, "readSqliteDatabaseScopedWriteToken");
  try {
    const result = readModelContextNavigationPages({
      database,
      sessionId: "sparse",
      generation: "synthetic-generation",
      through: 4_000_000,
      maxEvents: 10,
      readRows: (after, through) =>
        entries
          .filter((entry) => entry.seq > after && entry.seq <= through)
          .map((entry) => ({ entry, bytes: 1, withoutCheckpointBytes: 1 })),
    });
    expect(result.entries.map((entry) => entry.id)).toEqual(["first", "last"]);
    expect(receipts).toHaveBeenCalledTimes(2);
  } finally {
    receipts.mockRestore();
  }
});
