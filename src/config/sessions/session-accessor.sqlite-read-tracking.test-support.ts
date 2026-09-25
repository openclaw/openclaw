import { vi } from "vitest";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";

/**
 * Records the `session_key` of every row a read actually materializes from the
 * store, so a test can tell a memoized answer from one that re-read the table.
 *
 * The returned array stays empty exactly when nothing was materialized, which
 * is the observable difference between serving a reference question from an
 * active batch and falling back to a full scan.
 */
export function trackMaterializedKeys(database: Pick<OpenClawAgentDatabase, "db">): string[] {
  const materializedKeys: string[] = [];
  const prepare = database.db.prepare.bind(database.db);
  vi.spyOn(database.db, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    const iterate = statement.iterate.bind(statement);
    vi.spyOn(statement, "iterate").mockImplementation(function* (...args) {
      for (const row of iterate(...args)) {
        if (typeof row.session_key === "string") {
          materializedKeys.push(row.session_key);
        }
        yield row;
      }
      return undefined;
    });
    return statement;
  });
  return materializedKeys;
}
