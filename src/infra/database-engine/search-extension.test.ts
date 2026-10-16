import { expect, it, vi } from "vitest";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { admitStoreSearch } from "./adapters.js";

it("binds a SQLite search extension without issuing any SQL", () => {
  using db = openNodeSqliteDatabase(":memory:");
  const prepare = vi.spyOn(db, "prepare");
  const exec = vi.spyOn(db, "exec");
  const search = admitStoreSearch(
    db,
    {
      text: { body: { table: "memory_fts", fields: ["text"] } },
      vector: { chunks: { table: "memory_vec", alias: "v", rowShape: { id: "string" } } },
    },
    { extension: "memory" },
  );
  expect(search.fullText).not.toBeNull();
  expect(search.vector).not.toBeNull();
  expect(search.text.body?.table).toBe("memory_fts");
  expect(search.vectors.chunks?.table).toBe("memory_vec");
  expect(prepare.mock.calls).toEqual([]);
  expect(exec.mock.calls).toEqual([]);
});
