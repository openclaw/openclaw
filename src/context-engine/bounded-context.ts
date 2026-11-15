import { createHash } from "node:crypto";
import { estimateTokens } from "../../packages/agent-core/src/harness/compaction/compaction-cut-point.js";
import { selectBoundedContextStart } from "../config/sessions/session-bounded-context-selection.js";
import { resolveExpiredRuntimeContextContentBytes } from "./transcript-byte-limit.js";
import type { AssembleResult } from "./types.js";

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
