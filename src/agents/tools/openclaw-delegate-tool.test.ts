import { setImmediate as yieldToScheduler } from "node:timers/promises";
import { beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayRequestHandler } from "../../gateway/server-methods/types.js";
import { createContext } from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import * as caches from "../../plugins/plugin-cache.js";
import { createEmptyPluginMetadataSnapshot } from "../../plugins/plugin-metadata-empty.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import * as runtimeScope from "../../plugins/runtime/generation-scope.js";
import * as modelScope from "../prepared-model-runtime-generation-scope.js";
import type { PreparedModelRuntimePluginGeneration } from "../prepared-model-runtime.types.js";
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

it("cancels a delegated Gateway wait while its handler remains unsettled", async () => {
  const actual =
    await vi.importActual<typeof import("./in-process-gateway.js")>("./in-process-gateway.js");
  callGateway.mockImplementation(actual.callInProcessGatewayTool);
  const started = createDeferred();
  const release = createDeferred();
  const handler: GatewayRequestHandler = async ({ respond }) => {
    started.resolve();
    await release.promise;
    respond(true, { reply: "Applied.", action: "none" });
  };
  const context = createContext([["openclaw.chat", "operator.admin", "system-agent", handler]]);
  const controller = new AbortController();
  const stopped = new Error("synthetic turn stopped");
  const pending = callerScope.withGatewayToolCallerIdentity(
    { agentId: "main", sessionKey: runSessionKey, gatewayContextResolver: () => context },
    () => delegate().execute("call-1", { message: "Check setup." }, controller.signal),
  );
  const outcome = pending.catch((error: unknown) => error);
  try {
    await awaitGateBeforeSettlement(started.promise, pending, "Gateway handler not reached");
    controller.abort(stopped);
    expect(await Promise.race([outcome, yieldToScheduler()])).toBe(stopped);
  } finally {
    release.resolve();
    await pending.catch(() => undefined);
  }
});

it.each<[string, Options, boolean]>([
  [
    "explicit full overrides configured prompting",
    { execSession: { permissionMode: "full" }, config: { tools: { exec: { mode: "ask" } } } },
    true,
  ],
  [
    "agent-restricted default",
    {
      agentChannel: "telegram",
      config: { agents: { entries: { main: { tools: { exec: { mode: "ask" } } } } } },
    },
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
  if (options.agentChannel === "telegram") {
    expect(tool.description).toContain("approve in this chat");
  }
  expect(callGateway.mock.calls[0]?.[1]).not.toHaveProperty("fullPermission");
  expect(callGateway.mock.calls[0]?.[1].delegation).not.toHaveProperty("fullPermission");
  expect(callerScope.getGatewayToolCallerIdentity()).toBeUndefined();
});
