import type { PluginCompatRecord } from "./types.js";

export const SESSION_TRANSCRIPT_VIEW_COMPAT_RECORD = {
  code: "session-transcript-sync-view",
  status: "deprecated",
  owner: "sdk",
  deprecated: "2026-10-11",
  warningStarts: "2026-10-11",
  removeAfter: "2026-12-31",
  replacement:
    "Await loadCombinedSessionStoreForGatewayAsync from openclaw/plugin-sdk/session-transcript-hit. The synchronous export retains its complete, non-incognito view through 2026-12-31; removal ships in the first January 2027 stable release.",
  docsPath: "/plugins/sdk-migration/compatibility-policy#session-transcript-search-views",
  surfaces: ["openclaw/plugin-sdk/session-transcript-hit loadCombinedSessionStoreForGateway"],
  diagnostics: ["Bounded DEP_PLUGIN_SDK warning for synchronous session transcript views"],
} as const satisfies PluginCompatRecord;
