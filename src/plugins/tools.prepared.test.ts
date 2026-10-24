import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  makeEmptyPluginMetadataOwners,
  makePluginMetadataIndex,
  makePluginMetadataManifestRegistry,
  setCurrentPluginMetadataSnapshot,
} from "./current-plugin-metadata.test-support.js";
import {
  getGlobalHookRunner,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "./hook-runner-global.js";
import { addTestHook } from "./hooks.test-helpers.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import type { PluginRegistry } from "./registry-types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeGenerationRegistryScope } from "./runtime/generation-state.js";
import { resolvePluginTools } from "./tools.js";
import {
  createNamedToolEntry,
  createToolRegistry,
  makeTool,
} from "./tools.optional.test-helpers.js";

const pluginId = "approval-owner";
const toolName = "approved_tool";

function createPreparedFixture() {
  const config: OpenClawConfig = {
    plugins: { enabled: true, slots: { memory: "none" } },
  };
  const context = { config, workspaceDir: "/tmp" };
  const index = makePluginMetadataIndex(pluginId);
  const manifestRegistry = makePluginMetadataManifestRegistry(pluginId);
  const plugin = expectDefined(manifestRegistry.plugins[0], "plugin manifest");
  Object.assign(plugin, {
    origin: "bundled",
    rootDir: "/tmp",
    source: `/tmp/${pluginId}.js`,
    enabledByDefault: true,
    providers: [],
    contracts: { tools: [toolName] },
  });
  const snapshot: PluginMetadataSnapshot = {
    policyHash: resolveInstalledPluginIndexPolicyHash(config),
    workspaceDir: context.workspaceDir,
    index,
    registryIndex: index,
    registryDiagnostics: [],
    manifestRegistry,
    plugins: manifestRegistry.plugins,
    diagnostics: [],
    byPluginId: new Map([[pluginId, plugin]]),
    normalizePluginId: (id) => id,
    owners: makeEmptyPluginMetadataOwners(),
    declaredProviderOwners: new Map(),
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: 1,
      manifestPluginCount: 1,
    },
  };
  setCurrentPluginMetadataSnapshot(snapshot, { ...context, env: process.env });
  return {
    context,
    metadataSnapshot: snapshot,
    loadContext: {
      rawConfig: config,
      config,
      activationSourceConfig: config,
      autoEnabledReasons: {},
      workspaceDir: context.workspaceDir,
      env: Object.freeze({ ...process.env }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
  };
}

function createApprovalRegistry(): PluginRegistry {
  // Separate registrations must not share their private consent state.
  const approvedCalls = new Set<string>();
  const registry = createToolRegistry([
    createNamedToolEntry(pluginId, toolName, {
      factory: () => ({
        ...makeTool(toolName),
        async execute(toolCallId: string) {
          if (!approvedCalls.delete(toolCallId)) {
            throw new Error("Approval missing from this registration");
          }
          return { content: [{ type: "text", text: "approved" }] };
        },
      }),
    }),
  ]) as PluginRegistry;
  addTestHook({
    registry,
    pluginId,
    hookName: "before_tool_call",
    handler: () => ({
      requireApproval: {
        title: "Approve tool",
        description: "Execute this call once",
        onResolution: (resolution: string) => {
          if (resolution === "allow-once") {
            approvedCalls.add("approved-call");
          }
        },
      },
    }),
  });
  return registry;
}

afterEach(() => {
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
  setCurrentPluginMetadataSnapshot(undefined);
});

describe("prepared plugin tool registrations", () => {
  it.each(["allow-once", "deny"] as const)(
    "keeps %s approval and execution on the captured generation",
    async (decision) => {
      const { context, ...prepared } = createPreparedFixture();
      const rootRegistry = createApprovalRegistry();
      const preparedRegistry = createApprovalRegistry();
      setActivePluginRegistry(rootRegistry);
      initializeGlobalHookRunner(rootRegistry);
      const [tool] = resolvePluginTools({
        context,
        toolAllowlist: [toolName],
        runtimeRegistry: rootRegistry,
        preparedRuntime: { ...prepared, registry: preparedRegistry },
      });
      const resolvedTool = expectDefined(tool, "resolved approval tool");
      await withPluginRuntimeGenerationRegistryScope(preparedRegistry, async () => {
        const runner = expectDefined(getGlobalHookRunner(), "global hook runner");
        const result = await runner.runBeforeToolCall(
          { toolName, params: {} },
          { toolName, toolCallId: "approved-call" },
        );
        const approval = expectDefined(result?.requireApproval, "approval request");
        await approval.onResolution?.(decision);
        if (decision === "allow-once") {
          await expect(resolvedTool.execute("approved-call", {})).resolves.toEqual({
            content: [{ type: "text", text: "approved" }],
          });
        }
        await expect(resolvedTool.execute("approved-call", {})).rejects.toThrow(
          "Approval missing from this registration",
        );
      });
    },
  );

  it("honors an explicit environment override instead of the prepared registration", async () => {
    const { context, ...prepared } = createPreparedFixture();
    const overrideRegistry = createToolRegistry([createNamedToolEntry(pluginId, toolName)]);
    const [tool] = resolvePluginTools({
      context,
      env: { ...process.env },
      toolAllowlist: [toolName],
      runtimeRegistry: overrideRegistry as PluginRegistry,
      preparedRuntime: { ...prepared, registry: createApprovalRegistry() },
    });
    await expect(expectDefined(tool, "override tool").execute("override", {})).resolves.toEqual({
      content: [{ type: "text", text: "ok" }],
    });
  });
});
