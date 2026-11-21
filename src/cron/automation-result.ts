import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { validateAutomationResult } from "../../packages/gateway-protocol/src/compiled/cron-runtime.generated.js";
import type { AutomationResult } from "../../packages/gateway-protocol/src/schema/cron-automation-result.js";

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
  return validateAutomationResult(result) ? result : undefined;
}
