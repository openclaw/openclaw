import type { ContextEngine } from "./types.js";

export function createPassthroughEngineMethods(): Pick<
  ContextEngine,
  "ingest" | "assemble" | "compact"
> {
  return {
    async ingest() {
      return { ingested: true };
    },
    async assemble({ messages }) {
      return { messages, estimatedTokens: 0 };
    },
    async compact() {
      return { ok: true, compacted: false };
    },
  };
}
