import type { PluginCompatRecord } from "./types.js";

export const ASSISTANT_TEXT_PHASE_TERMINAL_HINT_COMPAT_RECORD = {
  code: "assistant-text-phase-terminal-hint",
  status: "deprecated",
  owner: "sdk",
  introduced: "2026-08-17",
  deprecated: "2026-10-11",
  warningStarts: "2026-10-11",
  removalGate: "next-plugin-sdk-major",
  replacement: "Omit textPhaseRequiresTerminal; unphased text is never retroactively classified.",
  docsPath: "/concepts/streaming#text-phases-and-final-replies",
  surfaces: ["AssistantMessage.openclawDelivery.textPhaseRequiresTerminal"],
  diagnostics: ["TypeScript @deprecated annotation; no runtime warning for the ignored field"],
  tests: ["src/plugin-sdk/assistant-message-compat.test.ts"],
} as const satisfies PluginCompatRecord;
