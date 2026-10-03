import type { PluginCompatRecord } from "./types.js";

export const WATCHED_SESSIONS_COMPAT_RECORD = {
  code: "watched-sessions-sync-harness-context",
  status: "deprecated",
  owner: "sdk",
  introduced: "2026-07-29",
  deprecated: "2026-10-03",
  warningStarts: "2026-10-03",
  removalGate: "next-plugin-sdk-major",
  replacement:
    "Await prepareWatchedSessionsHarnessContext with an assertCurrent callback bound to the current host capability. The released buildWatchedSessionsHarnessContext retains its synchronous string-or-undefined result until the next Plugin SDK major and explicit breaking-release approval.",
  docsPath: "/plugins/sdk-migration/compatibility-policy#watched-session-harness-context",
  surfaces: ["openclaw/plugin-sdk/agent-harness-runtime.buildWatchedSessionsHarnessContext"],
  diagnostics: [
    "TypeScript @deprecated annotation and migration documentation; no runtime warnings",
  ],
  tests: [
    "src/plugins/compat/registry.test.ts",
    "src/plugin-sdk/agent-harness-runtime-watched-sessions.test.ts",
    "src/agents/watched-sessions-prompt.test.ts",
  ],
  releaseNote:
    "Harness plugins can await watched-session prompt preparation from worker reads. Bundled harnesses use the awaited helper; the synchronous SDK result remains supported for third-party plugins. Prompt bytes, stored data, and update behavior are unchanged.",
} as const satisfies PluginCompatRecord;
