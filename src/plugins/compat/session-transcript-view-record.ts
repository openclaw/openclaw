import type { PluginCompatRecord } from "./types.js";

export const SESSION_TRANSCRIPT_VIEW_COMPAT_RECORD = {
  code: "session-transcript-sync-view",
  status: "deprecated",
  owner: "sdk",
  introduced: "2026-10-11",
  deprecated: "2026-10-11",
  warningStarts: "2026-10-11",
  removalGate: "next-plugin-sdk-major",
  replacement:
    "Await loadCombinedSessionStoreForGatewayAsync from openclaw/plugin-sdk/session-transcript-hit. The synchronous export retains its complete, non-incognito view until the next Plugin SDK major.",
  docsPath: "/plugins/sdk-migration/compatibility-policy#session-transcript-search-views",
  surfaces: ["openclaw/plugin-sdk/session-transcript-hit loadCombinedSessionStoreForGateway"],
  diagnostics: ["Bounded DEP_PLUGIN_SDK warning for synchronous session transcript views"],
  tests: ["src/plugin-sdk/session-transcript-hit.projection.test.ts"],
} as const satisfies PluginCompatRecord;
