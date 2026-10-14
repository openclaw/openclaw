import type { PluginCompatRecord } from "./types.js";

export const TTS_PREFERENCES_COMPAT_RECORD = {
  code: "tts-preferences-sync-resolution",
  status: "deprecated",
  owner: "sdk",
  introduced: "2026-10-03",
  deprecated: "2026-10-03",
  warningStarts: "2026-10-03",
  removeAfter: "2026-12-31",
  replacement:
    "Await resolveTtsPrefsPathAsync(config) for the machine-owned path. For prompt hints, await the public api.runtime.tts.buildSystemPromptHintAsync method. Bundled plugins can also await private prepareTtsPreferences and pass preparedTtsPreferences to the supported synchronous hint overload. The unprepared synchronous hint and preference-path calls remain compatible through 2026-12-31; removal ships in the first January 2027 stable release.",
  docsPath: "/plugins/sdk-migration/async-transcript-and-tts",
  surfaces: [
    "openclaw/plugin-sdk/agent-runtime resolveTtsPrefsPath",
    "openclaw/plugin-sdk/tts-runtime resolveTtsPrefsPath",
    "openclaw/plugin-sdk/tts-runtime buildTtsSystemPromptHint",
  ],
  diagnostics: [
    "Bounded DEP_PLUGIN_SDK warning for legacy path resolution and unprepared synchronous hint calls; prepared hints remain silent",
  ],
  tests: [
    "src/plugin-sdk/tts-preferences-compat.test.ts",
    "src/tts/tts-preferences.worker.test.ts",
    "src/plugins/compat/registry.test.ts",
  ],
  releaseNote:
    "Host TTS dispatch reuses worker-prepared preference paths while released plugin calls retain synchronous preference resolution. Preference-file reads, stored data, and update behavior are unchanged.",
} as const satisfies PluginCompatRecord;
