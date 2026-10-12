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
    "Await resolveTtsPrefsPathAsync(config) for the machine-owned path. Host dispatch carries worker-prepared preferences into synchronous prompt helpers. Retain released resolveTtsPrefsPath(config) and buildTtsSystemPromptHint(config, agentId, options) signatures until published plugin readers migrate and a breaking Plugin SDK release is explicitly approved.",
  docsPath: "/plugins/sdk-migration/compatibility-policy#tts-preference-resolution",
  surfaces: [
    "openclaw/plugin-sdk/agent-runtime resolveTtsPrefsPath",
    "openclaw/plugin-sdk/tts-runtime resolveTtsPrefsPath",
    "openclaw/plugin-sdk/tts-runtime buildTtsSystemPromptHint",
  ],
  diagnostics: ["Bounded DEP_PLUGIN_SDK warning for legacy path resolution"],
  tests: [
    "src/plugin-sdk/tts-preferences-compat.test.ts",
    "src/tts/tts-preferences.worker.test.ts",
    "src/plugins/compat/registry.test.ts",
  ],
  releaseNote:
    "Host TTS dispatch reuses worker-prepared preference paths while released plugin calls retain synchronous preference resolution. Preference-file reads, stored data, and update behavior are unchanged.",
} as const satisfies PluginCompatRecord;
