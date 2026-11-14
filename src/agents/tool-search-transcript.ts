import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { copyInternalToolResultState } from "../../packages/agent-core/src/internal-hooks.js";
import { markOwnedTranscriptPayload } from "../shared/transcript-payload-ownership.js";
import { transferMcpCodeModeGuestResult } from "./mcp-content.js";
import type { AgentToolResult } from "./runtime/index.js";
import { toToolSearchJsonSafe } from "./tool-search-json.js";

function freezeJsonSnapshot(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    for (const nested of value) {
      freezeJsonSnapshot(nested);
    }
  } else {
    // JSON decoding owns this graph; enumerate it without a values array per object.
    for (const key in value) {
      if (Object.hasOwn(value, key)) {
        freezeJsonSnapshot(Reflect.get(value, key));
      }
    }
  }
  return Object.freeze(value);
}

/** Capture a stable JSON-safe result before delayed transcript settlement. */
export function snapshotToolSearchTargetTranscriptResult(
  result: AgentToolResult<unknown>,
): AgentToolResult<unknown> {
  const hasDetails = "details" in result;
  const snapshot = toToolSearchJsonSafe(result);
  if (!isRecord(snapshot)) {
    throw new Error("Tool Search target result could not be captured for transcript projection.");
  }
  if (hasDetails && !("details" in snapshot)) {
    // `details` presence selects callValue unwrapping. JSON serialization drops
    // an explicit undefined, so restore that marker before freezing the envelope.
    snapshot.details =
      result.details === undefined ? undefined : toToolSearchJsonSafe(result.details);
  }
  const target = freezeJsonSnapshot(snapshot) as AgentToolResult<unknown>;
  // The envelope may retain undefined details; only its sealed JSON children are canonical.
  for (const key in snapshot) {
    const value = Object.hasOwn(snapshot, key) ? snapshot[key] : undefined;
    if (value && typeof value === "object") {
      markOwnedTranscriptPayload(value);
    }
  }
  return transferMcpCodeModeGuestResult(result, copyInternalToolResultState(result, target));
}
