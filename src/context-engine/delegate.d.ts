import type { MemoryCitationsMode } from "../config/types.memory.js";
import type { ContextEngine, CompactResult } from "./types.js";
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
export declare function delegateCompactionToRuntime(params: Parameters<ContextEngine["compact"]>[0]): Promise<CompactResult>;
/**
 * Build a context-engine-ready systemPromptAddition from the active memory
 * plugin prompt path. This lets non-legacy engines explicitly opt into the
 * same memory/wiki guidance that the legacy engine gets via system prompt
 * assembly, without reimplementing memory prompt formatting.
 */
export declare function buildMemorySystemPromptAddition(params: {
    availableTools: Set<string>;
    citationsMode?: MemoryCitationsMode;
}): string | undefined;
