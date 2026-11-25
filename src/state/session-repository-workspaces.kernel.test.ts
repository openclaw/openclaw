import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { admitSqliteSchema, runSqliteReadOperationSync } from "../infra/sqlite-schema-facts.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import type { DB } from "./openclaw-state-db.generated.js";
import { findSessionRepositoryWorkspaceInDatabase } from "./session-repository-workspaces.kernel.js";

it("compiles owner lookups once per connection while bindings and stored rows change", () => {
  const schema = extractSqliteTableSchema(
    readFileSync(new URL("./openclaw-state-schema.sql", import.meta.url), "utf8"),
    "session_repository_workspaces",
  );
  using first = openNodeSqliteDatabase(":memory:");
  using second = openNodeSqliteDatabase(":memory:");
  const owner = { agentId: "main", sessionKey: "session" };
  const sibling = { ...owner, agentId: "other" };
  const missing = { ...owner, sessionKey: "missing" };
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  for (const [db, branch] of [
    [first, "first"],
    [second, "second"],
  ] as const) {
    db.exec(schema);
    db.prepare(`INSERT INTO session_repository_workspaces
      (workspace_id, agent_id, session_key, url, branch, revision, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, 'https://example.test/repo.git', ?, 0, 1, 1)`).run(
      workspaceId,
      owner.agentId,
      owner.sessionKey,
      branch,
    );
    admitSqliteSchema(db);
  }
  const find = (db: typeof first, input: typeof owner) =>
    runSqliteReadOperationSync(db, () => findSessionRepositoryWorkspaceInDatabase(db, input));
  const selections = [first, second].map((db) =>
    vi.spyOn(getNodeSqliteKysely<Pick<DB, "session_repository_workspaces">>(db), "selectFrom"),
  );
  try {
    for (const db of [first, second, first, second]) {
      expect(find(db, owner)).toMatchObject({
        workspaceId,
        branch: db === first ? "first" : "second",
      });
      expect(find(db, sibling)).toBeUndefined();
      expect(find(db, missing)).toBeUndefined();
    }
    for (const selection of selections) {
      expect(
        selection.mock.calls.filter(([table]) => table === "session_repository_workspaces"),
      ).toHaveLength(1);
    }
    first
      .prepare(
        "UPDATE session_repository_workspaces SET revision = 1, branch = ? WHERE workspace_id = ?",
      )
      .run("updated", workspaceId);
    expect(find(first, owner)).toMatchObject({ branch: "updated", revision: 1 });
    expect(find(second, owner)).toMatchObject({ branch: "second", revision: 0 });
    first
      .prepare("DELETE FROM session_repository_workspaces WHERE workspace_id = ?")
      .run(workspaceId);
    expect(find(first, owner)).toBeUndefined();
    expect(find(second, owner)).toMatchObject({ workspaceId });
  } finally {
    for (const selection of selections) {
      selection.mockRestore();
    }
  }
});
