import type { SQLInputValue } from "node:sqlite";
import type { SqlConnection } from "../infra/sql-connection.js";

export function sessionSqlFixture(database: SqlConnection) {
  return (query: TemplateStringsArray, ...params: SQLInputValue[]) => {
    const statement = database.prepare(query.join("?"));
    return {
      run: (...values: SQLInputValue[]) => statement.run(...params, ...values),
      get: (...values: SQLInputValue[]) => statement.get(...params, ...values),
      all: (...values: SQLInputValue[]) => statement.all(...params, ...values),
    };
  };
}
