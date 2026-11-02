export const TRIAGE_EXTERNAL_AGENTS = [
  "codex",
  "claude",
  "pi",
  "opencode",
  "muse",
  "grok",
  "cursor",
  "kimi",
  "qwen",
  "agy",
] as const;
export type TriageExternalAgent = (typeof TRIAGE_EXTERNAL_AGENTS)[number];
