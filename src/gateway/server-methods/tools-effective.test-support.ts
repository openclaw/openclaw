import { vi } from "vitest";

type InventoryModule = typeof import("../../agents/tools-effective-inventory.js");
type AcquiredRuntimeModelContext = Awaited<
  ReturnType<InventoryModule["acquireEffectiveToolInventoryRuntimeModelContext"]>
>;
type RuntimeModelContext = Parameters<Parameters<AcquiredRuntimeModelContext["run"]>[0]>[0];

const toolsEffectiveInventoryMocks = vi.hoisted(() => {
  const resolveEffectiveToolInventory = vi.fn<InventoryModule["resolveEffectiveToolInventory"]>(
    async (params) => ({
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
    }),
  );

  const resolveEffectiveToolInventoryRuntimeModelContext = vi.fn(
    (_params?: unknown): RuntimeModelContext => ({ modelApi: "openai-responses" }),
  );
  return {
    resolveEffectiveToolInventory,
    resolveEffectiveToolInventoryRuntimeModelContext,
    acquireEffectiveToolInventoryRuntimeModelContext: vi.fn<
      InventoryModule["acquireEffectiveToolInventoryRuntimeModelContext"]
    >(async (params) => {
      const context = resolveEffectiveToolInventoryRuntimeModelContext(params);
      return { run: (project) => project(context), [Symbol.asyncDispose]: async () => {} };
    }),
  };
});

vi.mock("../../agents/tools-effective-inventory.js", () => toolsEffectiveInventoryMocks);
vi.mock("../../agents/agent-bundle-mcp-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-bundle-mcp-tools.js")>()),
  buildBundleMcpToolsFromCatalog: vi.fn(() => []),
  peekSessionMcpRuntime: vi.fn(() => undefined),
  resolveSessionMcpConfigSummary: vi.fn(() => ({
    fingerprint: "mcp:0",
    serverNames: new Array<string>(),
  })),
}));
vi.mock("../../plugins/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/runtime.js")>()),
  getActivePluginChannelRegistryVersion: vi.fn(() => 1),
  getActivePluginRegistryVersion: vi.fn(() => 1),
}));
vi.mock("../../agents/embedded-agent-runner/effective-tool-policy.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../agents/embedded-agent-runner/effective-tool-policy.js")
  >()),
  applyFinalEffectiveToolPolicy: vi.fn<
    typeof import("../../agents/embedded-agent-runner/effective-tool-policy.js").applyFinalEffectiveToolPolicy
  >((params) => params.bundledTools),
}));

export { toolsEffectiveInventoryMocks };
