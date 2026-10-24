import { Value } from "typebox/value";
import { beforeEach, expect, it, vi } from "vitest";
import * as caches from "../../plugins/plugin-cache.js";
import { createEmptyPluginMetadataSnapshot } from "../../plugins/plugin-metadata-empty.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import * as runtimeScope from "../../plugins/runtime/generation-scope.js";
import { GATEWAY_OWNER_ONLY_CORE_TOOLS } from "../../security/dangerous-tools.js";
import * as modelScope from "../prepared-model-runtime-generation-scope.js";
import type { PreparedModelRuntimePluginGeneration } from "../prepared-model-runtime.types.js";
import { compactToolOutputHint } from "../tool-schema-hints.js";
import * as callerScope from "./gateway-caller-context.js";
import { callInProcessGatewayTool } from "./in-process-gateway.js";
import { createOpenClawDelegateToolsForRun as createTools } from "./openclaw-delegate-tool.js";

// mock-isolation: Observe delegated Gateway calls without executing privileged Gateway operations.
vi.mock("./in-process-gateway.js", () => ({ callInProcessGatewayTool: vi.fn() }));

const callGateway = vi.mocked(callInProcessGatewayTool);

beforeEach(() => {
  callGateway.mockReset();
});

type Options = Omit<Parameters<typeof createTools>[0], "sessionAgentId">;
const runSessionKey = "agent:main:main";
function delegate(options: Options = {}) {
  const [tool] = createTools({ sessionAgentId: "main", runSessionKey, ...options });
  return tool ?? expect.fail("expected OpenClaw delegation tool");
}
function expectUnscoped() {
  expect(modelScope.getPreparedModelRuntimePluginGeneration()).toBeUndefined();
  expect(runtimeScope.getPluginRuntimeGenerationRegistry()).toBeUndefined();
  expect(caches.getScopedPluginCache()).toBeUndefined();
}

it("admits each delegated call outside its caller generation without dropping caller fences", async () => {
  await using cache = caches.createPluginCache();
  const registry = createEmptyPluginRegistry();
  const generation: PreparedModelRuntimePluginGeneration = {
    remoteCatalog: null,
    pluginMetadataSnapshot: createEmptyPluginMetadataSnapshot(),
    inlineProviderModels: [],
    configuredCatalogEntries: [],
  };
  caches.bindPluginMetadataSnapshotCache(generation.pluginMetadataSnapshot, cache);
  const controller = new AbortController();
  const approvalAuthorityCheck = vi.fn(() => true);
  const tool = delegate();
  const caller = {
    agentId: "main",
    sessionKey: runSessionKey,
    approvalAuthorityCheck,
    approvalSignals: [controller.signal],
  };
  callGateway.mockImplementation(async () => {
    expectUnscoped();
    expect(callerScope.getGatewayToolCallerIdentity()).toMatchObject(caller);
    return { reply: "Ready." };
  });
  await modelScope.withPreparedModelRuntimePluginGenerationScope(generation, () =>
    callerScope.withGatewayToolCallerIdentity(caller, () =>
      runtimeScope.withPluginRuntimeGenerationScope(
        { metadataSnapshot: generation.pluginMetadataSnapshot, pluginRegistry: registry },
        async () => {
          for (const message of ["First helper call", "Second helper call"]) {
            await tool.execute("delegate", { message });
            expect(modelScope.getPreparedModelRuntimePluginGeneration()).toBe(generation);
            expect(runtimeScope.getPluginRuntimeGenerationRegistry()).toBe(registry);
            expect(caches.getScopedPluginCache()).toBe(cache);
          }
        },
      ),
    ),
  );
  expect(callerScope.getGatewayToolCallerIdentity()).toBeUndefined();
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
  expect(tool.description).toContain("multiple named custom/local model endpoints");
  expect(tool.description).toContain(
    "provider IDs can be user-defined, while api selects the protocol",
  );
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
  expect(Value.Check(tool.outputSchema!, result.details)).toBe(true);
  expect(compactToolOutputHint(tool.outputSchema)).toBe("{ reply: string; action?: string }");
});

it.each<[string, Options, boolean]>([
  [
    "explicit full overrides configured prompting",
    { execSession: { permissionMode: "full" }, config: { tools: { exec: { mode: "ask" } } } },
    true,
  ],
  [
    "agent-restricted default",
    { config: { agents: { entries: { main: { tools: { exec: { mode: "ask" } } } } } } },
    false,
  ],
  [
    "turn-tightened full",
    { execSession: { permissionMode: "full" }, execOverrides: { ask: "always" } },
    false,
  ],
  ["filesystem-restricted", { fsPolicy: { workspaceOnly: true } }, false],
])("carries %s authority privately, not in RPC data", async (_name, options, full) => {
  const runController = new AbortController();
  const toolController = new AbortController();
  callGateway.mockImplementation(async () => {
    expect(callerScope.getGatewayToolCallerIdentity()?.fullPermission).toBe(full);
    expect(callerScope.getGatewayToolCallerIdentity()?.approvalSignals).toEqual([
      runController.signal,
      toolController.signal,
    ]);
    return { sessionId: "delegate", reply: "Done." };
  });
  const tool = delegate(options);
  expect(tool.catalogMode).toBe("direct-only");
  await callerScope.withGatewayToolCallerIdentity(
    { agentId: "main", sessionKey: runSessionKey, approvalSignals: [runController.signal] },
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
  expect(callerScope.getGatewayToolCallerIdentity()).toBeUndefined();
});

it("points telegram runs to in-chat approvals", () => {
  expect(
    delegate({ agentChannel: "telegram", execSession: { permissionMode: "guarded" } }).description,
  ).toContain("approve in this chat");
});
