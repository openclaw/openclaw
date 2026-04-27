import { delegateCompactionToRuntime } from "./delegate.js";
/**
 * LegacyContextEngine wraps the existing compaction behavior behind the
 * ContextEngine interface, preserving 100% backward compatibility.
 *
 * - ingest: no-op (SessionManager handles message persistence)
 * - assemble: pass-through (existing sanitize/validate/limit pipeline in attempt.ts handles this)
 * - compact: delegates to compactEmbeddedPiSessionDirect
 */
export class LegacyContextEngine {
    info = {
        id: "legacy",
        name: "Legacy Context Engine",
        version: "1.0.0",
    };
    async ingest(_params) {
        // No-op: SessionManager handles message persistence in the legacy flow
        return { ingested: false };
    }
    async assemble(params) {
        // Pass-through: the existing sanitize -> validate -> limit -> repair pipeline
        // in attempt.ts handles context assembly for the legacy engine.
        // We just return the messages as-is with a rough token estimate.
        return {
            messages: params.messages,
            estimatedTokens: 0, // Caller handles estimation
        };
    }
    async afterTurn(_params) {
        // No-op: legacy flow persists context directly in SessionManager.
    }
    async compact(params) {
        return await delegateCompactionToRuntime(params);
    }
    async dispose() {
        // Nothing to clean up for legacy engine
    }
}
