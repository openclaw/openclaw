import type { PluginCompatRecord } from "./types.js";

export const TTS_PREFERENCES_COMPAT_RECORD = {
  code: "tts-preferences-sync-resolution",
  status: "deprecated",
  owner: "sdk",
  introduced: "2026-10-03",
  deprecated: "2026-10-03",
  warningStarts: "2026-10-03",
  removalGate: "next-plugin-sdk-major",
  replacement:
    "Host dispatch prepares the machine-owned TTS preference path through the shared-state reader. Retain released resolveTtsPrefsPath(config) and buildTtsSystemPromptHint(config, agentId, options) calls with synchronous return values until a public preparation contract is available, published plugin readers migrate, and a breaking Plugin SDK release is explicitly approved.",
  docsPath: "/plugins/sdk-migration/compatibility-policy#tts-preference-resolution",
  surfaces: [
    "openclaw/plugin-sdk/agent-runtime resolveTtsPrefsPath",
    "openclaw/plugin-sdk/tts-runtime resolveTtsPrefsPath",
    "openclaw/plugin-sdk/tts-runtime buildTtsSystemPromptHint",
  ],
  diagnostics: ["Compatibility registry and migration documentation; no runtime warnings"],
  tests: [
    "src/plugin-sdk/tts-preferences-compat.test.ts",
    "src/tts/tts-preferences.worker.test.ts",
    "src/plugins/compat/registry.test.ts",
  ],
  releaseNote:
    "Host TTS dispatch reuses worker-prepared preference paths while released plugin calls retain synchronous preference resolution. Preference-file reads, stored data, and update behavior are unchanged.",
} as const satisfies PluginCompatRecord;
