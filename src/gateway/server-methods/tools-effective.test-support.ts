import { vi } from "vitest";
import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import { getRegisteredAgentHarness } from "../../agents/harness/registry.js";
import { resolveReplyToMode } from "../../auto-reply/reply/reply-threading.js";
import { resolveRuntimeConfigCacheKey } from "../../config/config.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.shared.js";
import { getConnectedNodePluginToolsVersion } from "../node-plugin-tool-snapshot.js";
import { loadGatewaySessionEntryReadOnly, resolveSessionModelRef } from "../session-utils.js";
type ToolsEffectiveDependencies = NonNullable<
  Parameters<(typeof import("./tools-effective.js"))["createToolsEffectiveHandlers"]>[0]
>;

const resolveEffectiveToolInventory = vi.fn<
  ToolsEffectiveDependencies["resolveEffectiveToolInventory"]
>((params) => ({
  agentId: params.agentId ?? "main",
  profile: "coding",
  groups: [
    {
      id: "core",
      label: "Built-in tools",
      source: "core",
      tools: [
        {
          id: "exec",
          label: "Exec",
          description: "Run shell commands",
          rawDescription: "Run shell commands",
          source: "core",
        },
      ],
    },
  ],
  modelProvider: params.modelProvider,
  modelId: params.modelId,
}));

type AcquiredRuntimeModelContext = Awaited<
  ReturnType<ToolsEffectiveDependencies["acquireEffectiveToolInventoryRuntimeModelContext"]>
>;
type RuntimeModelContext = Parameters<Parameters<AcquiredRuntimeModelContext["run"]>[0]>[0];

const resolveEffectiveToolInventoryRuntimeModelContext = vi.fn(
  (_params?: unknown): RuntimeModelContext => ({
    modelApi: "openai-responses",
  }),
);

export const toolsEffectiveInventoryMocks = {
  resolveEffectiveToolInventory,
  resolveEffectiveToolInventoryRuntimeModelContext,
};

const acquireEffectiveToolInventoryRuntimeModelContext = vi.fn<
  ToolsEffectiveDependencies["acquireEffectiveToolInventoryRuntimeModelContext"]
>(async (params) => {
  const context =
    toolsEffectiveInventoryMocks.resolveEffectiveToolInventoryRuntimeModelContext(params);
  return { run: (project) => project(context), release: () => {} };
});

export const toolsEffectiveTestDependencies: ToolsEffectiveDependencies = {
  applyFinalEffectiveToolPolicy: vi.fn<ToolsEffectiveDependencies["applyFinalEffectiveToolPolicy"]>(
    (params) => params.bundledTools,
  ),
  buildBundleMcpToolsFromCatalog: vi.fn<
    ToolsEffectiveDependencies["buildBundleMcpToolsFromCatalog"]
  >(() => []),
  deliveryContextFromSession,
  getActivePluginChannelRegistryVersion: vi.fn(() => 1),
  getActivePluginRegistryVersion: vi.fn(() => 1),
  getConnectedNodePluginToolsVersion,
  getRegisteredAgentHarness,
  listAgentIds,
  loadGatewaySessionEntryReadOnly,
  peekSessionMcpRuntime: vi.fn(() => undefined),
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveEffectiveToolInventory: toolsEffectiveInventoryMocks.resolveEffectiveToolInventory,
  acquireEffectiveToolInventoryRuntimeModelContext,
  resolveReplyToMode,
  resolveRuntimeConfigCacheKey,
  resolveSessionAgentId,
  resolveSessionMcpConfigSummary: vi.fn(() => ({
    fingerprint: "mcp:0",
    serverNames: new Array<string>(),
  })),
  resolveSessionModelRef,
};
