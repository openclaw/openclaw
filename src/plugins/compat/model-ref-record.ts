import type { PluginCompatRecord } from "./types.js";

export const MODEL_REF_COMPAT_RECORD = {
  code: "model-ref-sync-discovery",
  status: "deprecated",
  owner: "sdk",
  introduced: "2026-07-01",
  deprecated: "2026-10-12",
  warningStarts: "2026-10-12",
  replacement:
    "Await parseModelRefAsync from agent-runtime for one lookup, or await prepareModelRefResolver and reuse its synchronous parsing methods and manifestPlugins. Bundled plugins may use the private model-ref-parse seam. Released parseModelRef and resolveModelRefFromString exports preserve cold manifest discovery until a later release after stable deprecation and migration of published plugin readers.",
  docsPath: "/plugins/sdk-migration/compatibility-policy#model-reference-parsing",
  surfaces: [
    "openclaw/plugin-sdk/model-ref-parse parseModelRef",
    "openclaw/plugin-sdk/provider-model-shared parseModelRef",
    "openclaw/plugin-sdk/agent-runtime parseModelRef",
    "openclaw/plugin-sdk/agent-runtime resolveModelRefFromString",
  ],
  diagnostics: ["Bounded DEP_PLUGIN_SDK warning for synchronous model-reference parsing"],
  tests: [
    "src/plugins/manifest-model-id-normalization.test.ts",
    "src/agents/harness/model-catalog.test.ts",
    "src/plugins/compat/registry.test.ts",
  ],
  releaseNote:
    "Plugin model-reference parsing can prepare manifest aliases through the metadata worker. Existing synchronous SDK calls preserve their signatures, alias behavior, and completion timing; stored data and update behavior are unchanged.",
} as const satisfies PluginCompatRecord;
