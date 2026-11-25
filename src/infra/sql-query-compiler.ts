import {
  type BinaryOperationNode,
  type OperationNode,
  OperatorNode,
  PostgresDialect,
  PostgresQueryCompiler,
  RawNode,
  ValueNode,
} from "kysely";

const templateFragments = (fragments: TemplateStringsArray, _value: unknown) => fragments;
// Kysely retains these template arrays by identity; helper calls need no registration.
export const sqliteStringSetFragments = templateFragments`(SELECT value FROM json_each(${0}))`;
export const sqliteStringSetEntriesFragments = templateFragments`json_each(${0})`;

function postgresStringArray(node: OperationNode): string | undefined {
  if (
    !RawNode.is(node) ||
    node.sqlFragments !== sqliteStringSetFragments ||
    node.parameters.length !== 1
  ) {
    return undefined;
  }
  let parameter = node.parameters[0]!;
  while (
    RawNode.is(parameter) &&
    parameter.parameters.length === 1 &&
    parameter.sqlFragments.length === 2 &&
    parameter.sqlFragments.every((fragment) => fragment === "")
  ) {
    parameter = parameter.parameters[0]!;
  }
  if (!ValueNode.is(parameter) || parameter.immediate || typeof parameter.value !== "string") {
    return undefined;
  }
  let values: unknown;
  try {
    values = JSON.parse(parameter.value);
  } catch {
    // SQLite's JSON5 NUL encoding and opaque inputs retain the existing lowering.
    return undefined;
  }
  if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) {
    return undefined;
  }
  return `{${values.map((value) => `"${value.replace(/["\\]/g, "\\$&")}"`).join(",")}}`;
}

/** Lower only the shared string-set primitive; arbitrary raw SQL stays caller-owned. */
export class OpenClawPostgresQueryCompiler extends PostgresQueryCompiler {
  protected override visitBinaryOperation(node: BinaryOperationNode): void {
    if (OperatorNode.is(node.operator) && node.operator.operator === "in") {
      const array = postgresStringArray(node.rightOperand);
      if (array !== undefined) {
        this.visitNode(node.leftOperand);
        this.append(" = ANY(");
        this.appendValue(array);
        this.append("::text[])");
        return;
      }
    }
    super.visitBinaryOperation(node);
  }

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
