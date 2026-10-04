import type { DatabaseSync } from "node:sqlite";
import { expect, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { mergeImportedChatHistoryMessages } from "./cli-session-history.test-support.js";

export function mergeCliHistoryWithLookupStats(
  params: Parameters<typeof mergeImportedChatHistoryMessages>[0],
) {
  const sqlite = requireNodeSqlite();
  const { queries, restore } = observeSqliteReadSql(sqlite.StatementSync.prototype);
  const isTextLookup = (sql: string) =>
    sql.includes('from "messages" where "role" = ? and "text" = ?');
  // oxlint-disable-next-line typescript/unbound-method -- Called with its database receiver below.
  const prepare = sqlite.DatabaseSync.prototype.prepare;
  const planObserver = vi
    .spyOn(sqlite.DatabaseSync.prototype, "prepare")
    .mockImplementation(function (this: DatabaseSync, sql) {
      if (isTextLookup(sql)) {
        const plan = prepare
          .call(this, `EXPLAIN QUERY PLAN ${sql}`)
          .all(...Array.from(sql.matchAll(/\?/g), () => null));
        expect(plan).toHaveLength(1);
        const index = sql.includes('"timestamp" is null') ? "undated" : "timed";
        expect(plan[0]?.detail).toContain(`INDEX match_${index}_text`);
        expect(plan[0]?.detail).toContain("role=? AND text=? AND consumed=? AND id>?");
      }
      return prepare.call(this, sql);
    });
  try {
    const merged = mergeImportedChatHistoryMessages(params);
    const executions = queries.filter(
      (sql) => !sql.startsWith("EXPLAIN") && isTextLookup(sql),
    ).length;
    return { merged, executions };
  } finally {
    planObserver.mockRestore();
    restore();
  }
}
