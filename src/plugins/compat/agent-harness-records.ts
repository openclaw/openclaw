import type { PluginCompatRecord } from "./types.js";

const AGENT_HARNESS_TOOL_CONSTRUCTION_COMPAT_RECORD = {
  code: "agent-harness-sync-tool-construction",
  status: "deprecated",
  owner: "sdk",
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
} as const satisfies PluginCompatRecord;

export const AGENT_HARNESS_COMPAT_RECORDS = [
  AGENT_HARNESS_TOOL_CONSTRUCTION_COMPAT_RECORD,
  {
    code: "plugin-unused-registration-capabilities",
    status: "removed",
    owner: "sdk",
    // Immediate removal approved on October 19; no earlier warning window is claimed.
    removeAfter: "2026-10-18",
    replacement:
      "Use directly loadable media references, provider/backend-owned textTransforms, or externally managed AgentsAPI self_hosted environments. There is no replacement global overlay or controller registrar; migrate controller-owned sessions on the previous host first.",
    docsPath:
      "/plugins/sdk-migration/removed-surfaces#hosted-media-global-transforms-and-executor-controllers",
    surfaces: [
      "OpenClawPluginApi.registerHostedMediaResolver",
      "OpenClawPluginApi.registerTextTransforms",
      "OpenClawPluginApi.registerAgentExecutorController",
    ],
    diagnostics: [
      "TypeScript reports removed API members; saved controller state and configuration require migration",
    ],
  },
  {
    code: "codex-app-server-standalone-extension-runner",
    status: "active",
    owner: "agent-runtime",
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
  },
  {
    code: "agent-harness-tool-argument-redaction",
    status: "removed",
    owner: "agent-runtime",
    // Exclusive boundary: immediate removal was approved for October 11.
    removeAfter: "2026-10-10",
    replacement: "None; pass tool arguments unchanged. Secret masking belongs in diagnostics.",
    docsPath: "/plugins/sdk-migration/removed-surfaces#tool-argument-redaction",
    surfaces: ["openclaw/plugin-sdk/agent-harness-runtime.sanitizeToolArgs"],
    diagnostics: ["plugin SDK shipped-surface guard and migration guide"],
  },
  {
    code: "agent-harness-sdk-alias",
    status: "deprecated",
    owner: "agent-runtime",
    deprecated: "2026-04-25",
    warningStarts: "2026-04-25",
    replacement: "none yet; retain until a harness subpath ships and external migration is proven",
    docsPath: "/plugins/sdk-agent-harness",
    surfaces: ["openclaw/plugin-sdk/agent-harness", "openclaw/plugin-sdk/agent-harness-runtime"],
    diagnostics: ["plugin SDK compatibility warning"],
  },
] as const satisfies readonly PluginCompatRecord[];
