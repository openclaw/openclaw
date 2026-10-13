import type { PluginCompatRecord } from "./types.js";

export const MODEL_SESSION_AUTH_PROFILE_COMPAT_RECORD = {
  code: "model-session-sync-auth-profile",
  status: "deprecated",
  owner: "sdk",
  introduced: "2026-04-27",
  deprecated: "2026-10-11",
  warningStarts: "2026-10-11",
  replacement:
    "Await applyModelOverrideWithAuthProfileCompatibilityAsync from openclaw/plugin-sdk/model-session-runtime. The synchronous helper retains its return value and immediate mutation until a later release after stable deprecation.",
  docsPath: "/plugins/sdk-runtime/agent#model-selection-with-a-pinned-account",
  surfaces: [
    "openclaw/plugin-sdk/model-session-runtime applyModelOverrideWithAuthProfileCompatibility",
  ],
  diagnostics: ["Bounded DEP_PLUGIN_SDK warning for synchronous model account preservation"],
  tests: ["src/sessions/auth-profile-preservation.test.ts"],
  releaseNote:
    "Model selection can preserve a compatible pinned account through the async credential owner. Bundled callers await preparation; the synchronous Plugin SDK helper remains available with a deprecation warning. Stored accounts and session data are unchanged.",
} as const satisfies PluginCompatRecord;
