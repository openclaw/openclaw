import type { Api, Context, Model } from "@mariozechner/pi-ai";
import { createSubsystemLogger } from "../logging/subsystem.js";

type PendingToolCall = { id: string; name: string };

const log = createSubsystemLogger("agents/transport-message-transform");

/**
 * PR-9 Wave C-#1b: structured placeholder text used when a tool_use
 * has no matching tool_result at transport-assembly time. Carries
 * enough context (toolName + toolCallId) for the agent's read-time
 * context to surface a real diagnosis, AND a `[transport-repair]`
 * marker so log triage / Eva's transcript-anomaly heuristics can
 * distinguish "the tool actually failed" from "the result was lost
 * during reconstruction." Replaces the prior bare `"No result
 * provided"` string which was indistinguishable from a real failure
 * (Eva's reliability handoff #1b).
 */
function buildMissingToolResultText(toolCall: PendingToolCall): string {
  return [
    `[transport-repair] tool_use "${toolCall.name}" (id=${toolCall.id}) had no paired`,
    "tool_result at transport-assembly time. The original result was likely lost",
    "during session-history reconstruction (crash before disk flush, history",
    "compaction that dropped the pairing, or replay drift). This is a transport",
    "repair placeholder, NOT evidence that the tool itself failed — check the",
    "live agent logs and gateway transcript for the original result.",
  ].join(" ");
}

function appendMissingToolResults(
  result: Context["messages"],
  pendingToolCalls: PendingToolCall[],
  existingToolResultIds: ReadonlySet<string>,
): void {
  // Copilot review #68939 (2026-04-19): cap per-call log volume.
  // Pre-fix, the loop emitted one warn line per missing tool_result
  // — under failure modes where a reconstruction step drops many
  // pairings (e.g., a model hiccup leaving 50+ dangling tool_uses),
  // gateway.err.log gets flooded with one line each. Cap at the
  // first 5 warns + a single aggregate summary so operators still
  // see the issue but the log stays usable under incident
  // conditions.
  // Copilot review #68939 (round-2): bound the array growth at
  // (per-turn cap + aggregate cap). Pre-fix, `repaired` collected
  // ALL repaired items then sliced — pathological cases with
  // hundreds/thousands of missing tool_results would allocate a
  // huge intermediate array just to print 5 + 20 ids. Now we only
  // store enough ids to cover the diagnostic output AND maintain a
  // separate counter for the total. Keeps memory + CPU bounded
  // while preserving the same operator-facing diagnostics.
  const TRANSPORT_REPAIR_PER_TURN_LOG_CAP = 5;
  const TRANSPORT_REPAIR_AGGREGATE_ID_LIST_CAP = 20;
  const TRANSPORT_REPAIR_STORED_ID_CAP =
    TRANSPORT_REPAIR_PER_TURN_LOG_CAP + TRANSPORT_REPAIR_AGGREGATE_ID_LIST_CAP;
  const repairedIds: string[] = [];
  let totalRepairs = 0;
  for (const toolCall of pendingToolCalls) {
    if (!existingToolResultIds.has(toolCall.id)) {
      if (totalRepairs < TRANSPORT_REPAIR_PER_TURN_LOG_CAP) {
        // PR-9 Wave C-#1b: log the repair so operators can grep
        // `transport-repair` in gateway logs to find the originating
        // session+turn. The placeholder text already includes the
        // same marker so it's discoverable from both sides.
        log.warn(
          `transport-repair: synthesized placeholder for unpaired tool_use ` +
            `name=${toolCall.name} id=${toolCall.id}`,
        );
      }
      if (repairedIds.length < TRANSPORT_REPAIR_STORED_ID_CAP) {
        repairedIds.push(toolCall.id);
      }
      totalRepairs += 1;
      result.push({
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: buildMissingToolResultText(toolCall) }],
        isError: true,
        timestamp: Date.now(),
      });
    }
  }
  if (totalRepairs > TRANSPORT_REPAIR_PER_TURN_LOG_CAP) {
    // Show the next N ids beyond the per-turn log cap; surplus
    // repairs (those past the stored cap) are summarized as a count.
    const idList = repairedIds.slice(TRANSPORT_REPAIR_PER_TURN_LOG_CAP);
    const additional = totalRepairs - repairedIds.length;
    log.warn(
      `transport-repair: synthesized ${totalRepairs} placeholders this turn ` +
        `(only first ${TRANSPORT_REPAIR_PER_TURN_LOG_CAP} logged individually); ` +
        `next ${idList.length} tool_use ids: ${idList.join(", ")}` +
        (additional > 0 ? ` (+${additional} more)` : ""),
    );
  }
}

export function transformTransportMessages(
  messages: Context["messages"],
  model: Model<Api>,
  normalizeToolCallId?: (
    id: string,
    targetModel: Model<Api>,
    source: { provider: string; api: Api; model: string },
  ) => string,
): Context["messages"] {
  const toolCallIdMap = new Map<string, string>();
  const transformed = messages.map((msg) => {
    if (msg.role === "user") {
      return msg;
    }
    if (msg.role === "toolResult") {
      const normalizedId = toolCallIdMap.get(msg.toolCallId);
      return normalizedId && normalizedId !== msg.toolCallId
        ? { ...msg, toolCallId: normalizedId }
        : msg;
    }
    if (msg.role !== "assistant") {
      return msg;
    }
    const isSameModel =
      msg.provider === model.provider && msg.api === model.api && msg.model === model.id;
    const content: typeof msg.content = [];
    for (const block of msg.content) {
      if (block.type === "thinking") {
        if (block.redacted) {
          if (isSameModel) {
            content.push(block);
          }
          continue;
        }
        if (isSameModel && block.thinkingSignature) {
          content.push(block);
          continue;
        }
        if (!block.thinking.trim()) {
          continue;
        }
        content.push(isSameModel ? block : { type: "text", text: block.thinking });
        continue;
      }
      if (block.type === "text") {
        content.push(isSameModel ? block : { type: "text", text: block.text });
        continue;
      }
      if (block.type !== "toolCall") {
        content.push(block);
        continue;
      }
      let normalizedToolCall = block;
      if (!isSameModel && block.thoughtSignature) {
        normalizedToolCall = { ...normalizedToolCall };
        delete normalizedToolCall.thoughtSignature;
      }
      if (!isSameModel && normalizeToolCallId) {
        const normalizedId = normalizeToolCallId(block.id, model, msg);
        if (normalizedId !== block.id) {
          toolCallIdMap.set(block.id, normalizedId);
          normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
        }
      }
      content.push(normalizedToolCall);
    }
    return { ...msg, content };
  });

  const result: Context["messages"] = [];
  let pendingToolCalls: PendingToolCall[] = [];
  let existingToolResultIds = new Set<string>();
  for (const msg of transformed) {
    if (msg.role === "assistant") {
      if (pendingToolCalls.length > 0) {
        appendMissingToolResults(result, pendingToolCalls, existingToolResultIds);
        pendingToolCalls = [];
        existingToolResultIds = new Set();
      }
      if (msg.stopReason === "error" || msg.stopReason === "aborted") {
        continue;
      }
      const toolCalls = msg.content.filter(
        (block): block is Extract<(typeof msg.content)[number], { type: "toolCall" }> =>
          block.type === "toolCall",
      );
      if (toolCalls.length > 0) {
        pendingToolCalls = toolCalls.map((block) => ({ id: block.id, name: block.name }));
        existingToolResultIds = new Set();
      }
      result.push(msg);
      continue;
    }
    if (msg.role === "toolResult") {
      existingToolResultIds.add(msg.toolCallId);
      result.push(msg);
      continue;
    }
    if (pendingToolCalls.length > 0) {
      appendMissingToolResults(result, pendingToolCalls, existingToolResultIds);
      pendingToolCalls = [];
      existingToolResultIds = new Set();
    }
    result.push(msg);
  }
  return result;
}
