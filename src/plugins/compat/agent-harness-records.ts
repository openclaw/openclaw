import type { PluginCompatRecord } from "./types.js";

const AGENT_HARNESS_TOOL_CONSTRUCTION_COMPAT_RECORD = {
  code: "agent-harness-sync-tool-construction",
  status: "deprecated",
  owner: "sdk",
  introduced: "2026-09-08",
  deprecated: "2026-10-04",
  warningStarts: "2026-10-04",
  removalGate: "next-plugin-sdk-major",
  replacement:
    "Await hostCapabilities.createToolSurfaceAsync or createOpenClawCodingToolsAsync with the existing arguments. Released synchronous factories retain their array results and completion timing until the next Plugin SDK major and explicit breaking-release approval.",
  docsPath: "/plugins/sdk-migration/compatibility-policy#harness-tool-construction",
  surfaces: ["AgentHarnessHostCapabilities.createToolSurface", "createOpenClawCodingTools"],
  diagnostics: [
    "TypeScript @deprecated annotations and migration documentation; no runtime warnings",
  ],
  tests: [
    "src/plugin-sdk/agent-harness-async-compat.test.ts",
    "src/agents/harness/host-capability.test.ts",
    "src/plugins/compat/registry.test.ts",
  ],
  releaseNote:
    "Harness tool construction exposes awaited factories that read fresh exec policy through the existing worker and preserve live host authority. Synchronous SDK factories remain compatible; stored data and update behavior are unchanged.",
} as const satisfies PluginCompatRecord;

export const AGENT_HARNESS_COMPAT_RECORDS = [
  AGENT_HARNESS_TOOL_CONSTRUCTION_COMPAT_RECORD,
  {
    code: "agent-harness-tool-argument-redaction",
    status: "removed",
    owner: "agent-runtime",
    introduced: "2026-10-11",
    // Exclusive boundary: immediate removal was approved for October 11.
    removeAfter: "2026-10-10",
    replacement: "None; pass tool arguments unchanged. Secret masking belongs in diagnostics.",
    docsPath: "/plugins/sdk-migration/removed-surfaces#tool-argument-redaction",
    surfaces: ["openclaw/plugin-sdk/agent-harness-runtime.sanitizeToolArgs"],
    diagnostics: ["plugin SDK shipped-surface guard and migration guide"],
    tests: [
      "src/plugins/compat/registry.test.ts",
      "test/scripts/plugin-sdk-shipped-surface.test.ts",
    ],
    releaseNote:
      "Peter approved immediate removal of automatic tool argument and result masking on 2026-10-11. Drop sanitizeToolArgs imports and pass arguments unchanged; logging and diagnostic masking remains available.",
  },
  {
    code: "agent-harness-sdk-alias",
    status: "deprecated",
    owner: "agent-runtime",
    introduced: "2026-04-24",
    deprecated: "2026-04-25",
    warningStarts: "2026-04-25",
    replacement: "none yet; retain until a harness subpath ships and external migration is proven",
    docsPath: "/plugins/sdk-agent-harness",
    surfaces: ["openclaw/plugin-sdk/agent-harness", "openclaw/plugin-sdk/agent-harness-runtime"],
    diagnostics: ["plugin SDK compatibility warning"],
    tests: ["src/plugins/contracts/plugin-sdk-subpaths.test.ts"],
  },
] as const satisfies readonly PluginCompatRecord[];
