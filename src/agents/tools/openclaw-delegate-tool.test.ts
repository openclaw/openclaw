import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  createRuntimeConfigReader,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { captureRuntimeConfig } from "../../config/runtime-source-projection.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
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

vi.mock("./in-process-gateway.js", () => ({
  callInProcessGatewayTool: vi.fn(),
}));

const callGateway = vi.mocked(callInProcessGatewayTool);

afterEach(() => resetGlobalHookRunner());

beforeEach(() => {
  callGateway.mockReset();
});

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
    const [tool] = createOpenClawDelegateToolsForRun({
      sessionAgentId: "main",
      runSessionKey: "agent:main:main",
    });
    if (!tool) {
      throw new Error("expected OpenClaw delegation tool");
    }
    callGateway.mockImplementation(async () => {
      expect(getPreparedModelRuntimePluginGeneration()).toBeUndefined();
      expect(getPluginRuntimeGenerationRegistry()).toBeUndefined();
      expect(getScopedPluginCache()).toBeUndefined();
      expect(getGatewayToolCallerIdentity()).toMatchObject({
        agentId: "main",
        sessionKey: "agent:main:main",
        approvalAuthorityCheck,
        approvalSignals: [controller.signal],
      });
      return { reply: "Ready." };
    });
    await withPreparedModelRuntimePluginGenerationScope(generation, () =>
      withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          approvalAuthorityCheck,
          approvalSignals: [controller.signal],
        },
        () =>
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
    expect(getPreparedModelRuntimePluginGeneration()).toBeUndefined();
    expect(getPluginRuntimeGenerationRegistry()).toBeUndefined();
    expect(getScopedPluginCache()).toBeUndefined();
  });

  it("relays context and the completed approval outcome", async () => {
    callGateway.mockResolvedValue({
      sessionId: "ignored-by-client",
      reply: "Applied.",
      action: "none",
    });
    const tool = createOpenClawDelegateToolsForRun({
      sessionAgentId: "main",
      runSessionKey: "agent:main:dm:one",
      agentChannel: "webchat",
      execSession: { permissionMode: "guarded" },
    })[0];
    if (!tool) {
      throw new Error("expected OpenClaw delegation tool");
    }
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
    expect(result.details).toEqual({
      reply: "Applied.",
    });
    expect(tool.outputSchema).toBeDefined();
    expect(Value.Check(tool.outputSchema!, result.details)).toBe(true);
    expect(compactToolOutputHint(tool.outputSchema)).toBe("{ reply: string; action?: string }");
  });

  it.each<[string, Options, boolean]>([
    [
      "available unrestricted Gateway exec",
      { delegationExecAuthority: () => "gateway-host" },
      true,
    ],
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
      expect(getGatewayToolCallerIdentity()?.fullPermission).toBe(full);
      expect(getGatewayToolCallerIdentity()?.approvalSignals).toEqual([
        runController.signal,
        toolController.signal,
      ]);
      return { sessionId: "delegate", reply: "Done." };
    });
    const [tool] = createOpenClawDelegateToolsForRun({
      sessionAgentId: "main",
      runSessionKey: "agent:main:main",
      ...options,
    });
    if (!tool) {
      throw new Error("expected OpenClaw delegation tool");
    }

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

  it.each([{ agentChannel: "telegram", where: "in this chat" }])(
    "points $agentChannel runs to where approvals appear",
    ({ agentChannel, where }) => {
      // Only messaging channels receive approval prompts; the forwarder skips Webchat and TUI.
      const [tool] = createOpenClawDelegateToolsForRun({
        sessionAgentId: "main",
        runSessionKey: "agent:main:main",
        agentChannel,
        execSession: { permissionMode: "guarded" },
      });
      expect(tool?.description).toContain(`approve ${where}`);
    },
  );
});

it.each([true, undefined])(
  "rechecks current policy for a run grant (setting=%s)",
  async (setting) => {
    const config = { tools: { openclaw: { autoApproveChanges: setting } } };
    setRuntimeConfigSnapshot(config);
    try {
      const tool = delegate({ config, delegationExecAuthority: () => "gateway-host" });
      callGateway.mockImplementation(async () => {
        const caller = getGatewayToolCallerIdentity();
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

it.each(["before publication", "after publication", "foreign scope", "owner reader"] as const)(
  "rechecks captured delegation authority constructed %s",
  async (construction) => {
    const config = { tools: { openclaw: { autoApproveChanges: true } } };
    setRuntimeConfigSnapshot(config);
    try {
      const readDelegationConfig =
        construction === "owner reader" ? createRuntimeConfigReader(config) : undefined;
      const captured =
        construction === "owner reader"
          ? config
          : captureRuntimeConfig(construction === "foreign scope" ? {} : config);
      const construct = () => delegate({ config: captured, readDelegationConfig });
      const early = construction === "before publication" ? construct() : undefined;
      setRuntimeConfigSnapshot({ ...config, logging: { level: "debug" } });
      const tool = early ?? construct();
      callGateway.mockImplementation(async () => {
        const caller = getGatewayToolCallerIdentity();
        const assertCurrent = caller?.assertAutoApproveChangesCurrent;
        expect(assertCurrent).toBeTypeOf("function");
        if (construction === "foreign scope") {
          // An unrelated active grant must not replace this explicit scoped config.
          expect(caller?.fullPermission).toBe(false);
          expect(assertCurrent).toThrow("effective authority");
        } else {
          expect(caller?.fullPermission).toBe(true);
          expect(assertCurrent).not.toThrow();
        }
        setRuntimeConfigSnapshot({ tools: { openclaw: { autoApproveChanges: false } } });
        expect(assertCurrent).toThrow(
          construction === "foreign scope" ? "effective authority" : "require human approval",
        );
        return { reply: "Approval required." };
      });
      await tool.execute("captured-revoked-grant", { message: "Change logging." });
      expect(callGateway).toHaveBeenCalledOnce();
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
      const assertCurrent = getGatewayToolCallerIdentity()?.assertAutoApproveChangesCurrent;
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
      const assertCurrent = getGatewayToolCallerIdentity()?.assertAutoApproveChangesCurrent;
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
      const caller = getGatewayToolCallerIdentity();
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

type Options = Omit<Parameters<typeof createOpenClawDelegateToolsForRun>[0], "sessionAgentId">;
function delegate(options: Options = {}) {
  const [tool] = createOpenClawDelegateToolsForRun({
    sessionAgentId: "main",
    runSessionKey: "agent:main:main",
    ...options,
  });
  return tool ?? expect.fail("expected OpenClaw delegation tool");
}
