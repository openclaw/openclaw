import type { PluginCompatRecord } from "./types.js";

export const RUNTIME_CONFIG_COMPAT_RECORD = {
  code: "runtime-config-sync-load",
  status: "deprecated",
  owner: "config",
  deprecated: "2026-10-11",
  warningStarts: "2026-10-11",
  removeAfter: "2026-12-31",
  replacement:
    "Use readRuntimeConfig for the already prepared runtime snapshot. At a cold preparation boundary, await captureRuntimeConfigAsyncReader()() first or use its returned config. The released getRuntimeConfig keeps its synchronous cold-load behavior through 2026-12-31; removal ships in the first January 2027 stable release.",
  docsPath: "/plugins/sdk-migration/how-to-migrate#read-prepared-runtime-config",
  surfaces: [
    "openclaw/plugin-sdk/runtime-config-snapshot.getRuntimeConfig",
    "openclaw/plugin-sdk/memory-core-host-runtime-core.getRuntimeConfig",
  ],
  diagnostics: [
    "TypeScript @deprecated annotation and one DEP_SESSION_PERSISTENCE warning per plugin and runtime-config family per process on legacy use",
  ],
} as const satisfies PluginCompatRecord;
