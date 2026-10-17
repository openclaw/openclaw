import type { PluginCompatRecord } from "./types.js";

const AGENT_HARNESS_TOOL_CONSTRUCTION_COMPAT_RECORD = {
  code: "agent-harness-sync-tool-construction",
  status: "deprecated",
  owner: "sdk",
  introduced: "2026-09-08",
  deprecated: "2026-10-04",
  warningStarts: "2026-10-04",
  removeAfter: "2026-12-31",
  replacement:
    "Await hostCapabilities.createToolSurfaceAsync, createOpenClawCodingToolsAsync, or createAgentHarnessToolSurfaceRuntimeAsync with the existing arguments. Released synchronous factories retain their array results and completion timing through 2026-12-31; removal ships in the first January 2027 stable release without an SDK major.",
  docsPath: "/plugins/sdk-migration/compatibility-policy#harness-tool-construction",
  surfaces: [
    "AgentHarnessHostCapabilities.createToolSurface",
    "openclaw/plugin-sdk/agent-harness.createOpenClawCodingTools",
    "openclaw/plugin-sdk/agent-harness-tool-runtime.createAgentHarnessToolSurfaceRuntime",
  ],
  diagnostics: [
    "TypeScript @deprecated annotations and migration documentation; bounded capability-family warnings on legacy preparation",
  ],
  tests: [
    "test/type-contracts/agent-harness-async-compat.ts",
    "src/agents/harness/host-capability.test.ts",
    "src/plugins/compat/registry.test.ts",
  ],
  releaseNote:
    "Harness tool construction exposes awaited factories that read fresh exec policy through the existing worker and preserve live host authority. Synchronous SDK factories remain compatible; stored data and update behavior are unchanged.",
} as const satisfies PluginCompatRecord;

export const AGENT_HARNESS_COMPAT_RECORDS = [
  AGENT_HARNESS_TOOL_CONSTRUCTION_COMPAT_RECORD,
  {
    code: "codex-app-server-standalone-extension-runner",
    status: "active",
    owner: "agent-runtime",
    introduced: "2026-10-17",
    replacement:
      "Register transforms with api.registerAgentToolResultMiddleware and contracts.agentToolResultMiddleware. Retain the standalone runner and its types until supported published Codex packages no longer import it; @openclaw/codex@2026.10.4 still calls the default empty runner.",
    docsPath: "/plugins/sdk-migration/removed-surfaces#codex-app-server-extension-factories",
    surfaces: [
      "openclaw/plugin-sdk/agent-harness.createCodexAppServerToolResultExtensionRunner",
      "openclaw/plugin-sdk/agent-harness-runtime.createCodexAppServerToolResultExtensionRunner",
      "openclaw/plugin-sdk/agent-harness-runtime.CodexAppServerExtensionContext",
      "openclaw/plugin-sdk/agent-harness-runtime.CodexAppServerExtensionFactory",
      "openclaw/plugin-sdk/agent-harness-runtime.CodexAppServerExtensionRuntime",
      "openclaw/plugin-sdk/agent-harness-runtime.CodexAppServerToolResultEvent",
      "openclaw/plugin-sdk/agent-harness-runtime.CodexAppServerToolResultHandlerResult",
    ],
    diagnostics: ["plugin SDK compatibility registry and migration guide"],
    tests: [
      "src/agents/codex-app-server.extensions.test.ts",
      "src/plugins/compat/registry.test.ts",
    ],
    releaseNote:
      "The unused bundled-only factory registration and manifest contract are removed. Published Codex plugins retain the standalone runner, including caller-supplied factories and the default pass-through result.",
  },
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
