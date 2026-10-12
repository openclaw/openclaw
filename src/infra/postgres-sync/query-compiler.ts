import { PostgresDialect, PostgresQueryCompiler, type RawNode } from "kysely";

const templateFragments = (fragments: TemplateStringsArray, _value: unknown) => fragments;
// Kysely retains these template arrays by identity; helper calls need no registration.
export const sqliteStringSetFragments = templateFragments`(SELECT value FROM json_each(${0}))`;
export const sqliteStringSetEntriesFragments = templateFragments`json_each(${0})`;

/** Lower only the shared string-set primitive; arbitrary raw SQL stays caller-owned. */
export class OpenClawPostgresQueryCompiler extends PostgresQueryCompiler {
  protected override visitRaw(node: RawNode): void {
    const values = node.sqlFragments === sqliteStringSetFragments;
    if (!values && node.sqlFragments !== sqliteStringSetEntriesFragments) {
      super.visitRaw(node);
      return;
    }
    this.append(
      values
        ? "(SELECT value FROM json_array_elements_text("
        : "(SELECT ordinality - 1 AS key, value FROM json_array_elements_text(",
    );
    this.compileList(node.parameters);
    this.append(
      values ? "::json) AS value)" : "::json) WITH ORDINALITY AS entries(value, ordinality))",
    );
  }
}

export class OpenClawPostgresDialect extends PostgresDialect {
  override createQueryCompiler(): OpenClawPostgresQueryCompiler {
    return new OpenClawPostgresQueryCompiler();
  }
}
