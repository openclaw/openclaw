import { createHash } from "node:crypto";
import { estimateTokens } from "../../packages/agent-core/src/harness/compaction/compaction.js";
import { classifyToolUseResultPairing } from "../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import { resolveExpiredRuntimeContextContentBytes } from "./transcript-byte-limit.js";
import type { AssembleResult } from "./types.js";

/** Shared cut policy; cold readers measure payloads lazily from newest to oldest. */
export function selectBoundedContextStart(
  messages: readonly AssembleResult["messages"][number][],
  maxBytes: number,
  tokenBudget: number | undefined,
  measure: (index: number) => { bytes: number; tokens: number },
): number {
  let bytes = 2;
  let tokens = 0;
  let cut = messages.length;
  let exceedsByteBudget = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const size = measure(index);
    bytes += size.bytes + 1;
    tokens += size.tokens;
    if (bytes > maxBytes) {
      exceedsByteBudget = true;
      break;
    }
    if (tokenBudget !== undefined && tokens > tokenBudget) {
      continue;
    }
    if (index === 0 || messages[index]!.role === "user") {
      cut = index;
    }
  }
  // Ordinary token pressure still belongs to semantic compaction.
  if (!exceedsByteBudget) {
    return 0;
  }
  // Pairing uses the complete navigation, including calls outside the measured suffix.
  for (const frame of classifyToolUseResultPairing(messages)) {
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
  return cut;
}

/** Bounds only the model view; required instructions and the pending input stay with their owners. */
export function boundContextEngineAssembly(
  assembled: AssembleResult,
  maxBytes: number | undefined,
  tokenBudget?: number,
  additionalBytes?: ReadonlyMap<AssembleResult["messages"][number], number>,
  clearsTurnScopedSystemUpdates = false,
): AssembleResult {
  if (maxBytes === undefined) {
    return assembled;
  }
  const { messages } = assembled;
  const expiredContentBytes = clearsTurnScopedSystemUpdates
    ? resolveExpiredRuntimeContextContentBytes(messages)
    : undefined;
  const cut = selectBoundedContextStart(messages, maxBytes, tokenBudget, (index) => {
    const message = messages[index]!;
    const extraBytes = additionalBytes?.get(message) ?? 0;
    return {
      bytes:
        Buffer.byteLength(JSON.stringify(message), "utf8") +
        extraBytes -
        (expiredContentBytes?.get(message) ?? 0),
      tokens:
        (expiredContentBytes?.has(message) ? 0 : estimateTokens(message)) +
        (extraBytes ? Math.ceil(extraBytes / 4) : 0),
    };
  });
  if (!cut) {
    return assembled;
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
    estimatedTokens: retained.reduce((sum, message) => {
      const extraBytes = additionalBytes?.get(message) ?? 0;
      return (
        sum +
        (expiredContentBytes?.has(message) ? 0 : estimateTokens(message)) +
        (extraBytes ? Math.ceil(extraBytes / 4) : 0)
      );
    }, 0),
    promptAuthority: "assembled",
    // Persistent backends must replace the old native context, not append a
    // bounded view to a thread that still contains the omitted messages.
    contextProjection: { mode: "thread_bootstrap", epoch: `bounded:${fingerprint}`, fingerprint },
  };
}
