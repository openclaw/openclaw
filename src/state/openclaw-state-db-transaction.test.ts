import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { runManagedStateTransaction } from "./openclaw-state-db-transaction.js";

it("commits an ordinary shared-state transaction", () => {
  using database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE entries (value TEXT NOT NULL)");
  const withCommit = vi.fn((commit: () => void) => commit());

  runManagedStateTransaction(
    database,
    () => database.prepare("INSERT INTO entries (value) VALUES (?)").run("cli"),
    { withCommit },
  );

  expect(withCommit).toHaveBeenCalledOnce();
  expect(database.prepare("SELECT value FROM entries").all()).toEqual([{ value: "cli" }]);
});
