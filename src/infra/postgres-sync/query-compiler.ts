import { PostgresDialect, PostgresQueryCompiler, type OperationNode, type RawNode } from "kysely";

export const sqliteStringSetNodes = new WeakMap<OperationNode, "values" | "entries">();

/** Lower only the shared string-set primitive; arbitrary raw SQL stays caller-owned. */
export class OpenClawPostgresQueryCompiler extends PostgresQueryCompiler {
  protected override visitRaw(node: RawNode): void {
    const kind = sqliteStringSetNodes.get(node);
    if (!kind) {
      super.visitRaw(node);
      return;
    }
    this.append(
      kind === "values"
        ? "(SELECT value FROM json_array_elements_text("
        : "(SELECT ordinality - 1 AS key, value FROM json_array_elements_text(",
    );
    this.compileList(node.parameters);
    this.append(
      kind === "values"
        ? "::json) AS value)"
        : "::json) WITH ORDINALITY AS entries(value, ordinality))",
    );
  }
}

export class OpenClawPostgresDialect extends PostgresDialect {
  override createQueryCompiler(): OpenClawPostgresQueryCompiler {
    return new OpenClawPostgresQueryCompiler();
  }
}
