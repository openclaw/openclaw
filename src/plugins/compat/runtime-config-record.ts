import type { PluginCompatRecord } from "./types.js";

export const RUNTIME_CONFIG_COMPAT_RECORD = {
  code: "runtime-config-sync-load",
  status: "deprecated",
  owner: "config",
  introduced: "2026-04-27",
  deprecated: "2026-10-11",
  warningStarts: "2026-10-11",
  removalGate: "stable-deprecation-period",
  replacement:
    "Use readRuntimeConfig for the already prepared runtime snapshot. At a cold preparation boundary, await captureRuntimeConfigAsyncReader()() first or use its returned config. The released getRuntimeConfig keeps its synchronous cold-load behavior until removal in a later stable release after deprecation ships.",
  docsPath: "/plugins/sdk-migration/how-to-migrate#read-prepared-runtime-config",
  surfaces: [
    "openclaw/plugin-sdk/runtime-config-snapshot.getRuntimeConfig",
    "openclaw/plugin-sdk/memory-core-host-runtime-core.getRuntimeConfig",
  ],
  diagnostics: [
    "TypeScript @deprecated annotation and one DEP_SESSION_PERSISTENCE warning per plugin and runtime-config family per process on legacy use",
  ],
  tests: [
    "src/config/runtime-snapshot.test.ts",
    "src/config/io.runtime-async.test.ts",
    "src/plugins/compat/registry.test.ts",
  ],
  releaseNote:
    "Runtime config readers consume prepared snapshots without synchronous storage access. Cold callers can await the existing preparation owner, while the deprecated SDK getter retains its released completion contract. Stored config and update behavior are unchanged.",
} as const satisfies PluginCompatRecord;
