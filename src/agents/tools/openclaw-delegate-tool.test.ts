import { setImmediate as yieldToScheduler } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { GatewayRequestHandler } from "../../gateway/server-methods/types.js";
import { createContext } from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
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

afterEach(() => resetGlobalHookRunner());

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
  ["available unrestricted Gateway exec", { delegationExecAuthority: () => "gateway-host" }, true],
  [
    "inferred full with false",
    {
      delegationExecAuthority: () => "gateway-host",
      config: { tools: { openclaw: { autoApproveChanges: false } } },
    },
    false,
  ],
  [
    "inferred full with true",
    {
      delegationExecAuthority: () => "gateway-host",
      config: { tools: { openclaw: { autoApproveChanges: true } } },
    },
    true,
  ],
  [
    "explicit full with true",
    {
      execSession: { permissionMode: "full" },
      config: { tools: { openclaw: { autoApproveChanges: true } } },
    },
    true,
  ],
  [
    "agent grant overrides global false",
    {
      config: {
        tools: { openclaw: { autoApproveChanges: false } },
        agents: { entries: { main: { tools: { openclaw: { autoApproveChanges: true } } } } },
      },
    },
    true,
  ],
  ["missing callable exec", { config: { tools: { exec: { mode: "full" } } } }, false],
  [
    "node exec",
    { delegationExecAuthority: () => "gateway-host", execOverrides: { host: "node" } },
    false,
  ],
  [
    "standing grant with prompting exec",
    { config: { tools: { exec: { mode: "ask" }, openclaw: { autoApproveChanges: true } } } },
    true,
  ],
  [
    "explicit Off in Full Access",
    {
      execSession: { permissionMode: "full" },
      config: { tools: { openclaw: { autoApproveChanges: false } } },
    },
    false,
  ],
  [
    "agent Off overrides global grant",
    {
      config: {
        tools: { openclaw: { autoApproveChanges: true } },
        agents: { entries: { main: { tools: { openclaw: { autoApproveChanges: false } } } } },
      },
    },
    false,
  ],
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
  expect(tool.description).toContain("Changes wait for the user to approve");
  if (options.agentChannel === "telegram") {
    expect(tool.description).toContain("approve in this chat");
  }
  expect(callGateway.mock.calls[0]?.[1]).not.toHaveProperty("fullPermission");
  expect(callGateway.mock.calls[0]?.[1].delegation).not.toHaveProperty("fullPermission");
  expect(callerScope.getGatewayToolCallerIdentity()).toBeUndefined();
});

it("keeps setup self-delegation unavailable even when the configured user agent collides", () => {
  const config = { agents: { entries: { openclaw: { tools: { alsoAllow: ["openclaw"] } } } } };
  expect(createTools({ sessionAgentId: "openclaw", config })).toEqual([]);
  expect(createTools({ sessionAgentId: "openclaw" })).toEqual([]);
  expect(callGateway).not.toHaveBeenCalled();
});

it.each([true, undefined])(
  "rechecks current policy for a run grant (setting=%s)",
  async (setting) => {
    const config = { tools: { openclaw: { autoApproveChanges: setting } } };
    setRuntimeConfigSnapshot(config);
    try {
      const tool = delegate({ config, delegationExecAuthority: () => "gateway-host" });
      callGateway.mockImplementation(async () => {
        const caller = callerScope.getGatewayToolCallerIdentity();
        expect(caller?.fullPermission).toBe(true);
        setRuntimeConfigSnapshot({ ...config, logging: { level: "debug" } });
        expect(() => caller?.assertAutoApproveChangesCurrent?.()).not.toThrow();
        setRuntimeConfigSnapshot({ tools: { openclaw: { autoApproveChanges: false } } });
        expect(() => caller?.assertAutoApproveChangesCurrent?.()).toThrow("require human approval");
        return { reply: "Approval required." };
      });
      await tool.execute("revoked-grant", { message: "Change logging." });
    } finally {
      clearRuntimeConfigSnapshot();
    }
  },
);

it.each<[Options, string[]]>([
  [
    { sessionPermissionPolicy: { mode: "workspace", root: "/workspace" } },
    ['permission mode "workspace"', "session or its parent", "autoApproveChanges", "new run"],
  ],
  [
    { fsPolicy: { workspaceOnly: true } },
    [
      "limited to workspace files",
      "source of this restriction is not established",
      "autoApproveChanges",
    ],
  ],
  [
    { config: { tools: { fs: { workspaceOnly: true } } } },
    ["tools.fs.workspaceOnly", "operator configuration", "autoApproveChanges"],
  ],
  [
    { config: { agents: { entries: { main: { tools: { fs: { workspaceOnly: true } } } } } } },
    ["agents.entries.main.tools.fs.workspaceOnly", "operator configuration", "autoApproveChanges"],
  ],
])(
  "explains the verified restriction and recovery without inventing its source: %j",
  async (options, parts) => {
    callGateway.mockImplementation(async () => {
      const assertCurrent =
        callerScope.getGatewayToolCallerIdentity()?.assertAutoApproveChangesCurrent;
      for (const part of parts) {
        expect(assertCurrent).toThrow(part);
      }
      return { reply: "Approval required." };
    });
    await delegate(options).execute("restricted-recovery", { message: "Change logging." });
  },
);

it("names the sandbox policy changed since this run was admitted", async () => {
  const config = { tools: { openclaw: { autoApproveChanges: true } } };
  setRuntimeConfigSnapshot(config);
  try {
    const tool = delegate({ config });
    callGateway.mockImplementation(async () => {
      setRuntimeConfigSnapshot({ ...config, agents: { defaults: { sandbox: { mode: "all" } } } });
      const assertCurrent =
        callerScope.getGatewayToolCallerIdentity()?.assertAutoApproveChangesCurrent;
      expect(assertCurrent).toThrow("agents.defaults.sandbox changed");
      expect(assertCurrent).toThrow("new run");
      expect(assertCurrent).toThrow("autoApproveChanges");
      return { reply: "Approval required." };
    });
    await tool.execute("changed-sandbox", { message: "Change logging." });
  } finally {
    clearRuntimeConfigSnapshot();
  }
});

it.each(["hook", "trusted"] as const)(
  "rechecks applicable %s execution policy without blocking unrelated hooks",
  async (kind) => {
    const registry = createEmptyPluginRegistry();
    const handler = () => ({ block: true, blockReason: "fixture restriction" });
    if (kind === "hook") {
      registry.typedHooks.push({
        pluginId: "fixture",
        source: "test",
        hookName: "before_tool_call",
        matcher: ["read"],
        handler,
      });
    } else {
      registry.trustedToolPolicies.push({
        pluginId: "fixture",
        source: "test",
        policy: {
          id: "fixture",
          description: "Fixture execution gate",
          matcher: ["read"],
          evaluate: handler,
        },
      });
    }
    initializeGlobalHookRunner(registry);
    callGateway.mockImplementation(async () => {
      const caller = callerScope.getGatewayToolCallerIdentity();
      expect(caller?.fullPermission).toBe(true);
      expect(() => caller?.assertAutoApproveChangesCurrent?.()).not.toThrow();
      if (kind === "hook") {
        registry.typedHooks[0]!.matcher = ["exec"];
      } else {
        registry.trustedToolPolicies[0]!.policy.matcher = ["exec"];
      }
      expect(() => caller?.assertAutoApproveChangesCurrent?.()).toThrow("effective authority");
      return { reply: "Approval required." };
    });
    await delegate({ delegationExecAuthority: () => "gateway-host" }).execute("policy", {
      message: "Change logging.",
    });
  },
);
