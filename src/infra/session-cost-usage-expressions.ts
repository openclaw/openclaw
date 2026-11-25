import {
  expressionBuilder,
  type ExpressionWrapper,
  type ExtractTypeFromReferenceExpression,
} from "kysely";
import type { DB } from "../state/openclaw-agent-db.generated.js";

const cacheExpressions = expressionBuilder<Pick<DB, "cache_entries">, "cache_entries">();

export function usageCacheJsonText(value: string | Uint8Array) {
  return typeof value === "string"
    ? value
    : cacheExpressions.cast<string>(cacheExpressions.val(value), "text");
}

export function boundedUsageCacheColumn<Column extends "value_json" | "blob">(
  column: Column,
  budget?: { remainingBytes: number },
): ExpressionWrapper<
  Pick<DB, "cache_entries">,
  "cache_entries",
  ExtractTypeFromReferenceExpression<Pick<DB, "cache_entries">, "cache_entries", Column> | null
> {
  if (!budget) {
    return cacheExpressions.ref(column);
  }
  return cacheExpressions
    .case()
    .when(
      cacheExpressions.fn<number>(column === "value_json" ? "octet_length" : "length", [column]),
      "<=",
      column === "value_json" ? 64 * 1024 : Math.min(1024 * 1024, budget.remainingBytes),
    )
    .then(cacheExpressions.ref(column))
    .else(null)
    .end();
}
