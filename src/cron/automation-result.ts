import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import {
  AutomationResultSchema,
  type AutomationResult,
} from "../../packages/gateway-protocol/src/schema/cron-automation-result.js";

/** A recorded result never settles a yielded turn or outstanding tool work. */
export function hasPendingAutomationContinuation(
  meta:
    | {
        yielded?: boolean;
        continuationPending?: boolean;
        pendingToolCalls?: readonly unknown[];
      }
    | undefined,
): boolean {
  return (
    meta?.yielded === true ||
    meta?.continuationPending === true ||
    (meta?.pendingToolCalls?.length ?? 0) > 0
  );
}

/** Normalize once at the model/stored-history boundary against the wire contract. */
export function parseAutomationResult(value: unknown): AutomationResult | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const result =
    typeof value.summary === "string" ? { ...value, summary: value.summary.trim() } : { ...value };
  return Value.Check(AutomationResultSchema, result) ? result : undefined;
}
