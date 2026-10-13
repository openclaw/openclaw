import type { PluginCompatRecord } from "./types.js";

export const WATCHED_SESSIONS_COMPAT_RECORD = {
  code: "watched-sessions-sync-harness-context",
  status: "removed",
  owner: "sdk",
  introduced: "2026-07-29",
  deprecated: "2026-10-03",
  warningStarts: "2026-10-03",
  replacement:
    "Await prepareWatchedSessionsHarnessContext with an assertCurrent callback bound to the current host capability.",
  docsPath: "/plugins/sdk-migration/compatibility-policy#watched-session-harness-context",
  surfaces: ["openclaw/plugin-sdk/agent-harness-runtime.buildWatchedSessionsHarnessContext"],
  diagnostics: ["plugin compatibility registry and migration guide"],
  tests: ["src/plugins/compat/registry.test.ts", "src/agents/watched-sessions-prompt.test.ts"],
  releaseNote:
    "Removes synchronous watched-session prompt construction first deprecated in stable v2026.10.1. Harnesses await worker-prepared facts and retain current disclosure authority during consumption. Prompt bytes, stored data, and update behavior are unchanged.",
} as const satisfies PluginCompatRecord;
