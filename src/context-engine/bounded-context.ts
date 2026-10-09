import { createHash } from "node:crypto";
import { estimateTokens } from "../../packages/agent-core/src/harness/compaction/compaction.js";
import { classifyToolUseResultPairing } from "../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import type { AssembleResult } from "./types.js";

/** Bounds only the model view; required instructions and the pending input stay with their owners. */
export function boundContextEngineAssembly(
  assembled: AssembleResult,
  maxBytes: number | undefined,
  tokenBudget?: number,
): AssembleResult {
  if (maxBytes === undefined) {
    return assembled;
  }
  const { messages } = assembled;
  let bytes = 2;
  let tokens = 0;
  let cut = messages.length;
  let exceedsByteBudget = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    bytes += Buffer.byteLength(JSON.stringify(message), "utf8") + 1;
    tokens += estimateTokens(message);
    if (bytes > maxBytes) {
      exceedsByteBudget = true;
      break;
    }
    if (tokenBudget !== undefined && tokens > tokenBudget) {
      continue;
    }
    if (index === 0 || message.role === "user") {
      cut = index;
    }
  }
  // Ordinary token pressure still belongs to semantic compaction.
  if (!exceedsByteBudget) {
    return assembled;
  }
  // User messages can arrive between a call and its result. Advance past the
  // complete occurrence rather than retaining an orphan or exceeding the budget.
  for (const frame of classifyToolUseResultPairing(messages).frames) {
    if (frame.startIndex >= cut) {
      break;
    }
    for (const occurrence of frame.occurrences) {
      if (occurrence.sourceResultIndex !== undefined && occurrence.sourceResultIndex >= cut) {
        cut = occurrence.sourceResultIndex + 1;
        while (cut < messages.length && messages[cut]?.role !== "user") {
          cut++;
        }
      }
    }
  }
  const retained = messages.slice(cut);
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        assembled.contextProjection,
        maxBytes,
        messages[cut - 1],
        retained,
        assembled.systemPromptAddition,
      ]),
    )
    .digest("hex");
  return {
    ...assembled,
    messages: retained,
    estimatedTokens: retained.reduce((sum, message) => sum + estimateTokens(message), 0),
    promptAuthority: "assembled",
    // Persistent backends must replace the old native context, not append a
    // bounded view to a thread that still contains the omitted messages.
    contextProjection: { mode: "thread_bootstrap", epoch: `bounded:${fingerprint}`, fingerprint },
  };
}
