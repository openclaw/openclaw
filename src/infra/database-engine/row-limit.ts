import { sql, type RawBuilder } from "kysely";
import { isPostgresSqlConnection, type EngineConnection } from "../sql-connection.js";

/** OFFSET requires a LIMIT in SQLite; PostgreSQL spells an unbounded limit ALL. */
export function engineUnboundedRowLimit(db: EngineConnection): RawBuilder<number> {
  return isPostgresSqlConnection(db)
    ? /* kysely-allow-raw: Engine-owned unbounded LIMIT syntax. */ sql<number>`all`
    : sql.lit(-1);
}
