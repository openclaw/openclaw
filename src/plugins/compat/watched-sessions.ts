import type { PluginCompatRecord } from "./types.js";

export const WATCHED_SESSIONS_COMPAT_RECORD = {
  code: "watched-sessions-sync-harness-context",
  status: "deprecated",
  owner: "sdk",
  deprecated: "2026-10-03",
  warningStarts: "2026-10-03",
  removeAfter: "2026-12-31",
  replacement:
    "Await prepareWatchedSessionsHarnessContext with an assertCurrent callback bound to the current host capability. The released buildWatchedSessionsHarnessContext retains its synchronous string-or-undefined result through 2026-12-31; removal ships in the first January 2027 stable release without an SDK major.",
  docsPath: "/plugins/sdk-migration/compatibility-policy#watched-session-harness-context",
  surfaces: ["openclaw/plugin-sdk/agent-harness-runtime.buildWatchedSessionsHarnessContext"],
  diagnostics: [
    "TypeScript @deprecated annotation and migration documentation; bounded capability-family warnings on legacy preparation",
  ],
} as const satisfies PluginCompatRecord;
