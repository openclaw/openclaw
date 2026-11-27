import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { abortControlledSubagents } from "../../agents/subagents/cancel-descendants.js";

export function descendantAbortError(
  result: Awaited<ReturnType<typeof abortControlledSubagents>>,
  subject: "Parent run" | "Session",
) {
  return result && result.status !== "ok"
    ? errorShape(
        ErrorCodes.UNAVAILABLE,
        `${subject} stopped, but descendant cancellation was incomplete: ${result.error}`,
      )
    : undefined;
}
