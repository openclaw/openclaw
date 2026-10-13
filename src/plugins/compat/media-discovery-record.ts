import type { PluginCompatRecord } from "./types.js";

export const MEDIA_DISCOVERY_COMPAT_RECORD = {
  code: "media-sync-discovery",
  status: "deprecated",
  owner: "sdk",
  introduced: "2026-10-11",
  deprecated: "2026-10-11",
  warningStarts: "2026-10-11",
  replacement:
    "Await resolveAutoMediaKeyProvidersAsync and resolveDefaultMediaModelAsync from openclaw/plugin-sdk/media-runtime. The synchronous methods retain their signatures and return values until a later release after stable deprecation.",
  docsPath: "/plugins/sdk-migration/compatibility-policy#media-discovery",
  surfaces: [
    "openclaw/plugin-sdk/media-runtime resolveAutoMediaKeyProviders",
    "openclaw/plugin-sdk/media-runtime resolveDefaultMediaModel",
  ],
  diagnostics: ["Bounded DEP_PLUGIN_SDK warning for synchronous media discovery"],
  tests: ["src/plugin-sdk/media-discovery-compat.test.ts"],
} as const satisfies PluginCompatRecord;
