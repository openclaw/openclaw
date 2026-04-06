import type { ContextEngine, CompactResult, ContextEngineRuntimeContext } from "./types.js";

/**
 * Delegate a context-engine compaction request to OpenClaw's built-in runtime compaction path.
 *
 * This is the same bridge used by the legacy context engine. Third-party
 * engines can call it from their own `compact()` implementations when they do
 * not own the compaction algorithm but still need `/compact` and overflow
 * recovery to use the stock runtime behavior.
 *
 * Note: `compactionTarget` is part of the public `compact()` contract, but the
 * built-in runtime compaction path does not expose that knob. This helper
 * ignores it to preserve legacy behavior; engines that need target-specific
 * compaction should implement their own `compact()` algorithm.
 */
export async function delegateCompactionToRuntime(
  params: Parameters<ContextEngine["compact"]>[0],
): Promise<CompactResult> {
  // Import through a dedicated runtime boundary so the lazy edge remains effective.
  const { compactEmbeddedPiSessionDirect } =
    await import("../agents/pi-embedded-runner/compact.runtime.js");
  type RuntimeCompactionParams = Parameters<typeof compactEmbeddedPiSessionDirect>[0];

  // runtimeContext carries the full CompactEmbeddedPiSessionParams fields set
  // by runtime callers. We spread them and override the fields that come from
  // the public ContextEngine compact() signature directly.
  const runtimeContext = (params.runtimeContext ?? {}) as ContextEngineRuntimeContext &
    Partial<RuntimeCompactionParams>;
  const currentTokenCount =
    params.currentTokenCount ??
    (typeof runtimeContext.currentTokenCount === "number" &&
    Number.isFinite(runtimeContext.currentTokenCount) &&
    runtimeContext.currentTokenCount > 0
      ? Math.floor(runtimeContext.currentTokenCount)
      : undefined);

  const result = await compactEmbeddedPiSessionDirect({
    ...runtimeContext,
    sessionId: params.sessionId,
    sessionFile: params.sessionFile,
    tokenBudget: params.tokenBudget,
    ...(currentTokenCount !== undefined ? { currentTokenCount } : {}),
    force: params.force,
    customInstructions: params.customInstructions,
    workspaceDir:
      typeof runtimeContext.workspaceDir === "string" ? runtimeContext.workspaceDir : process.cwd(),
  });

  return {
    ok: result.ok,
    compacted: result.compacted,
    reason: result.reason,
    result: result.result
      ? {
          summary: result.result.summary,
          firstKeptEntryId: result.result.firstKeptEntryId,
          tokensBefore: result.result.tokensBefore,
          tokensAfter: result.result.tokensAfter,
          details: result.result.details,
        }
      : undefined,
  };
}
