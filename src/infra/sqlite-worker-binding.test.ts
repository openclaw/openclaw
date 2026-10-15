import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { bindSqliteWorkerDatabase } from "./sqlite-worker-binding.js";

it("closes a publication scope without closing its borrowed database", () => {
  const db = new DatabaseSync(":memory:");
  let cleaned = false;
  const backend = bindSqliteWorkerDatabase<{ read: { input: undefined; output: number } }>(db, {
    execute: () => 42,
    close() {
      cleaned = true;
    },
  });
  try {
    expect(backend.execute({ type: "read", input: undefined })).toBe(42);
    backend.assertSettled();
    db.exec("BEGIN");
    expect(() => backend.assertSettled()).toThrow("unsettled transaction");
    db.exec("ROLLBACK");
    backend.close();
    expect(cleaned).toBe(true);
    expect(db.isOpen).toBe(true);
    expect(() => backend.execute({ type: "read", input: undefined })).toThrow("binding is closed");
    expect(() => backend.assertOpen()).toThrow("binding is closed");
  } finally {
    db.close();
  }
});
