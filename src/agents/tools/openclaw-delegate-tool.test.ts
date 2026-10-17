import { Value } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindPluginMetadataSnapshotCache,
  createPluginCache,
  getScopedPluginCache,
} from "../../plugins/plugin-cache.js";
import { createEmptyPluginMetadataSnapshot } from "../../plugins/plugin-metadata-empty.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  getPluginRuntimeGenerationRegistry,
  withPluginRuntimeGenerationScope,
} from "../../plugins/runtime/generation-scope.js";
import { GATEWAY_OWNER_ONLY_CORE_TOOLS } from "../../security/dangerous-tools.js";
import {
  getPreparedModelRuntimePluginGeneration,
  withPreparedModelRuntimePluginGenerationScope,
} from "../prepared-model-runtime-generation-scope.js";
import type { PreparedModelRuntimePluginGeneration } from "../prepared-model-runtime.types.js";
import { compactToolOutputHint } from "../tool-schema-hints.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import { callInProcessGatewayTool } from "./in-process-gateway.js";
import { createOpenClawDelegateToolsForRun } from "./openclaw-delegate-tool.js";

vi.mock("./in-process-gateway.js", () => ({ callInProcessGatewayTool: vi.fn() }));

const callGateway = vi.mocked(callInProcessGatewayTool);

beforeEach(() => {
  callGateway.mockReset();
});

type Options = Omit<Parameters<typeof createOpenClawDelegateToolsForRun>[0], "sessionAgentId">;
function delegate(options: Options = {}) {
  const [tool] = createOpenClawDelegateToolsForRun({
    sessionAgentId: "main",
    runSessionKey: "agent:main:main",
    ...options,
  });
  if (!tool) {
    throw new Error("expected OpenClaw delegation tool");
  }
  return tool;
}
function expectUnscoped() {
  expect(getPreparedModelRuntimePluginGeneration()).toBeUndefined();
  expect(getPluginRuntimeGenerationRegistry()).toBeUndefined();
  expect(getScopedPluginCache()).toBeUndefined();
}

describe("openclaw delegation tool", () => {
  it("admits each delegated call outside its caller generation without dropping caller fences", async () => {
    await using cache = createPluginCache();
    const registry = createEmptyPluginRegistry();
    const generation: PreparedModelRuntimePluginGeneration = {
      remoteCatalog: null,
      pluginMetadataSnapshot: createEmptyPluginMetadataSnapshot(),
      inlineProviderModels: [],
      configuredCatalogEntries: [],
    };
    bindPluginMetadataSnapshotCache(generation.pluginMetadataSnapshot, cache);
    const controller = new AbortController();
    const approvalAuthorityCheck = vi.fn(() => true);
    const tool = delegate();
    const caller = {
      agentId: "main",
      sessionKey: "agent:main:main",
      approvalAuthorityCheck,
      approvalSignals: [controller.signal],
    };
    callGateway.mockImplementation(async () => {
      expectUnscoped();
      expect(getGatewayToolCallerIdentity()).toMatchObject(caller);
      return { reply: "Ready." };
    });
    await withPreparedModelRuntimePluginGenerationScope(generation, () =>
      withGatewayToolCallerIdentity(caller, () =>
        withPluginRuntimeGenerationScope(
          { metadataSnapshot: generation.pluginMetadataSnapshot, pluginRegistry: registry },
          async () => {
            for (const message of ["First helper call", "Second helper call"]) {
              await tool.execute("delegate", { message });
              expect(getPreparedModelRuntimePluginGeneration()).toBe(generation);
              expect(getPluginRuntimeGenerationRegistry()).toBe(registry);
              expect(getScopedPluginCache()).toBe(cache);
            }
          },
        ),
      ),
    );
    expect(getGatewayToolCallerIdentity()).toBeUndefined();
    expectUnscoped();
  });

  it("relays context and the completed approval outcome", async () => {
    callGateway.mockResolvedValue({
      sessionId: "ignored-by-client",
      reply: "Applied.",
      action: "none",
    });
    const tool = delegate({
      runSessionKey: "agent:main:dm:one",
      agentChannel: "webchat",
      execSession: { permissionMode: "guarded" },
    });
    expect(tool.description).toContain("Gateway restart");
    expect(tool.description).toContain("approve in the Control UI");
    expect(GATEWAY_OWNER_ONLY_CORE_TOOLS).toContain("openclaw");

    const result = await tool.execute("call-1", { message: "Add channel." });

    expect(callGateway).toHaveBeenCalledWith("openclaw.chat", {
      sessionId: expect.stringMatching(/^delegate-[a-f0-9]{32}$/),
      message: "Add channel.",
      delegation: {
        agentId: "main",
        sessionKey: "agent:main:dm:one",
        turnSourceChannel: "webchat",
      },
    });
    expect(result.details).toEqual({ reply: "Applied." });
    expect(tool.outputSchema).toBeDefined();
    expect(Value.Check(tool.outputSchema!, result.details)).toBe(true);
    expect(compactToolOutputHint(tool.outputSchema)).toBe("{ reply: string; action?: string }");
  });

  it.each([
    {
      name: "explicit full overrides configured prompting",
      options: {
        execSession: { permissionMode: "full" },
        config: { tools: { exec: { mode: "ask" } } },
      },
      full: true,
    },
    {
      name: "agent-restricted default",
      options: { config: { agents: { entries: { main: { tools: { exec: { mode: "ask" } } } } } } },
      full: false,
    },
    {
      name: "turn-tightened full",
      options: { execSession: { permissionMode: "full" }, execOverrides: { ask: "always" } },
      full: false,
    },
    { name: "filesystem-restricted", options: { fsPolicy: { workspaceOnly: true } }, full: false },
  ] satisfies Array<{
    name: string;
    options: Options;
    full: boolean;
  }>)("carries $name authority privately, not in RPC data", async ({ options, full }) => {
    const runController = new AbortController();
    const toolController = new AbortController();
    callGateway.mockImplementation(async () => {
      expect(getGatewayToolCallerIdentity()?.fullPermission).toBe(full);
      expect(getGatewayToolCallerIdentity()?.approvalSignals).toEqual([
        runController.signal,
        toolController.signal,
      ]);
      return { sessionId: "delegate", reply: "Done." };
    });
    const tool = delegate(options);

    expect(tool.catalogMode).toBe("direct-only");
    await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:main", approvalSignals: [runController.signal] },
      () =>
        tool.execute(
          "call-policy",
          { message: "Change logging.", fullPermission: !full },
          toolController.signal,
        ),
    );

    expect(tool.description).toContain(
      full ? "without asking for approval" : "Changes wait for the user to approve",
    );
    expect(callGateway.mock.calls[0]?.[1]).not.toHaveProperty("fullPermission");
    expect(callGateway.mock.calls[0]?.[1].delegation).not.toHaveProperty("fullPermission");
    expect(getGatewayToolCallerIdentity()).toBeUndefined();
  });

  it("points telegram runs to in-chat approvals", () => {
    expect(
      delegate({ agentChannel: "telegram", execSession: { permissionMode: "guarded" } })
        .description,
    ).toContain("approve in this chat");
  });
});
