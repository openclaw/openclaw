// Host hook contract tests cover plugin host hook registration and runtime behavior.
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  PROTOCOL_VERSION,
  validatePluginsUiDescriptorsResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { createCodexAppServerToolResultExtensionRunner } from "../../agents/harness/codex-app-server-extensions.js";
import { resolveSessionStorePathCore, type SessionEntry } from "../../config/sessions.js";
import {
  clearPluginOwnedSessionState,
  listSessionEntriesCore,
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "../../gateway/methods/registry.js";
import {
  ADMIN_SCOPE,
  APPROVALS_SCOPE,
  READ_SCOPE,
  WRITE_SCOPE,
} from "../../gateway/operator-scopes.js";
import { pluginHostHookHandlers } from "../../gateway/server-methods/plugin-host-hooks.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { buildGatewaySessionRow } from "../../gateway/session-utils-row.js";
import { withTempConfig } from "../../gateway/test-temp-config.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import type {
  AgentToolResultMiddlewareContext,
  AgentToolResultMiddlewareEvent,
} from "../agent-tool-result-middleware-types.js";
import type { CodexAppServerExtensionFactory } from "../codex-app-server-extension-types.js";
import { registerPluginCommandInRegistry } from "../command-registration.js";
import { executePluginCommand } from "../commands.js";
import { createHookRunner } from "../hooks.js";
import { createPluginHostRegistryRetirement, runPluginHostCleanup } from "../host-hook-cleanup.js";
import { getPluginRunContext } from "../host-hook-runtime.js";
import { listPluginSessionSchedulerJobs } from "../host-hook-runtime.test-fixtures.js";
import {
  drainPluginNextTurnInjectionContext,
  enqueuePluginNextTurnInjection,
  getPluginSessionExtensionStateSync,
  patchPluginSessionExtension,
  projectPluginSessionExtensionsSync,
} from "../host-hook-state.js";
import {
  buildPluginAgentTurnPrepareContext,
  isPluginJsonValue,
  type PluginTrustedToolPolicyRegistration,
} from "../host-hooks.js";
import { getPluginInstance } from "../plugin-instance-scope.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { createPluginRegistry } from "../registry.js";
import {
  clearActivePluginRegistry,
  getActivePluginRegistryVersion,
  disposePluginRegistryInstances,
  setActivePluginRegistry,
  stageActivePluginRegistry,
} from "../runtime.js";
import type { PluginRuntime } from "../runtime/types.js";
import { createPluginRecord } from "../status.test-helpers.js";
import {
  getTrustedToolPolicyMatcherScope,
  runTrustedToolPolicies,
} from "../trusted-tool-policy.js";
import { registerHostHookFixture } from "./host-hook-fixture.js";
import { hostHookUiProjection } from "./test-helpers/host-hook-ui-projection.js";

async function waitForPluginEventHandlers(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function joinContextFragments(...fragments: Array<string | undefined>): string {
  const present: string[] = [];
  for (const fragment of fragments) {
    if (fragment) {
      present.push(fragment);
    }
  }
  return present.join("\n\n");
}

function createHostHookFixtureRegistry() {
  return createPluginRegistryFixture({
    plugins: {
      entries: {
        "host-hook-fixture": {
          hooks: {
            allowConversationAccess: true,
          },
        },
      },
    },
  });
}

function registerFixture(
  record: Parameters<typeof createPluginRecord>[0],
  register: Parameters<typeof registerTestPlugin>[0]["register"],
) {
  const fixture = createPluginRegistryFixture();
  registerTestPlugin({ ...fixture, record: createPluginRecord(record), register });
  return fixture;
}

function policyRegistry(...evaluators: PluginTrustedToolPolicyRegistration["evaluate"][]) {
  const registry = createEmptyPluginRegistry();
  registry.trustedToolPolicies = evaluators.map((evaluate, index) => ({
    pluginId: `policy-${index}`,
    source: "test",
    policy: { id: `policy-${index}`, description: "Fixture policy", evaluate },
  }));
  return registry;
}

function requireFirstCommandRegistration(
  registry: ReturnType<typeof createPluginRegistryFixture>["registry"]["registry"],
) {
  const registration = registry.commands[0];
  if (!registration) {
    throw new Error("expected first plugin command registration");
  }
  return registration;
}

function diagnosticSummaries(diagnostics: readonly unknown[]) {
  return diagnostics.map((entry) => {
    const diagnostic = entry as { pluginId?: string; message?: string };
    return { pluginId: diagnostic.pluginId, message: diagnostic.message };
  });
}

function loadSessionStore(
  storePath: string,
  _options?: { skipCache?: boolean },
): Record<string, SessionEntry> {
  return Object.fromEntries(
    listSessionEntriesCore({ agentId: "main", storePath }).map(({ sessionKey, entry }) => [
      sessionKey,
      entry,
    ]),
  );
}

async function updateSessionStore(
  storePath: string,
  update: (store: Record<string, SessionEntry>) => void,
): Promise<void> {
  const store: Record<string, SessionEntry> = {};
  update(store);
  for (const [sessionKey, entry] of Object.entries(store)) {
    await replaceSessionEntry({ sessionKey, storePath }, entry);
  }
}

function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

type HostHookStateFixture = {
  stateDir: string;
  storePath: string;
  tempConfig: { session: { store: string } } & Record<string, unknown>;
};

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-host-hooks-scope-");

async function withHostHookState(
  run: (fixture: HostHookStateFixture) => Promise<void>,
  createTempConfig: (storePath: string) => HostHookStateFixture["tempConfig"] = (storePath) => ({
    agents: { entries: { main: {} } },
    session: { store: storePath },
  }),
): Promise<void> {
  const stateDir = sessionDirs.make();
  const storePath = path.join(stateDir, "sessions.json");
  const tempConfig = createTempConfig(storePath);
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    await withTempConfig({
      cfg: tempConfig,
      run: async () => await run({ stateDir, storePath, tempConfig }),
    });
  });
}

describe("host-hook fixture plugin contract", () => {
  afterEach(async () => {
    try {
      await clearActivePluginRegistry();
    } finally {
      resetAgentEventsForTest();
    }
  });

  it("registers generic SDK seams without Plan Mode business logic", () => {
    const { config, registry } = createHostHookFixtureRegistry();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "host-hook-fixture",
        name: "Host Hook Fixture",
        origin: "workspace",
        contracts: { tools: ["approval_fixture_tool"] },
      }),
      register: registerHostHookFixture,
    });

    expect(registry.registry.sessionExtensions).toHaveLength(1);
    expect(registry.registry.toolMetadata).toHaveLength(1);
    expect(registry.registry.controlUiDescriptors).toHaveLength(1);
    expect(registry.registry.runtimeLifecycles).toHaveLength(1);
    expect(registry.registry.agentEventSubscriptions).toHaveLength(1);
    expect(registry.registry.sessionSchedulerJobs).toHaveLength(1);
    expect(registry.registry.commands.map((entry) => entry.command.name)).toEqual([
      "host-hook-fixture",
    ]);
    expect(registry.registry.typedHooks.map((entry) => entry.hookName).toSorted()).toEqual([
      "agent_turn_prepare",
      "heartbeat_prompt_contribution",
    ]);
  });

  it("rejects external plugins from trusted policy and reserved command ownership", () => {
    const { registry } = registerFixture(
      {
        id: "external-policy",
        name: "External Policy",
        origin: "workspace",
      },
      (api) => {
        api.registerTrustedToolPolicy({
          id: "deny",
          description: "Should not be accepted",
          evaluate: () => undefined,
        });
        api.registerCommand({
          name: "status",
          description: "Should not be accepted",
          ownership: "reserved",
          handler: async () => ({ text: "no" }),
        });
      },
    );

    expect(registry.registry.trustedToolPolicies).toHaveLength(0);
    expect(registry.registry.commands).toHaveLength(0);
    const diagnostics = diagnosticSummaries(registry.registry.diagnostics);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]?.pluginId).toBe("external-policy");
    expect(diagnostics[0]?.message).toContain(
      "plugin must declare contracts.trustedToolPolicies for: deny",
    );
    expect(diagnostics[1]?.pluginId).toBe("external-policy");
    expect(diagnostics[1]?.message).toContain("only bundled plugins can claim reserved command");
  });

  it("rejects declared external trusted policy registration without explicit opt-in", () => {
    const { registry } = registerFixture(
      {
        id: "external-policy",
        name: "External Policy",
        origin: "workspace",
        contracts: { trustedToolPolicies: ["deny"] },
        explicitlyEnabled: false,
        activationSource: "default",
      },
      (api) => {
        api.registerTrustedToolPolicy({
          id: "deny",
          description: "Declared external policy",
          evaluate: () => ({ block: true, blockReason: "blocked by external policy" }),
        });
      },
    );

    expect(registry.registry.trustedToolPolicies).toHaveLength(0);
    expect(diagnosticSummaries(registry.registry.diagnostics)).toEqual([
      {
        pluginId: "external-policy",
        message: "plugin must be explicitly enabled to register trusted tool policy: deny",
      },
    ]);
  });

  it("rejects declared external tool-result middleware registration without explicit opt-in", () => {
    const { registry } = registerFixture(
      {
        id: "external-middleware",
        name: "External Middleware",
        origin: "workspace",
        contracts: { agentToolResultMiddleware: ["codex"] },
        explicitlyEnabled: false,
        activationSource: "default",
      },
      (api) => {
        api.registerAgentToolResultMiddleware(async (event) => ({ result: event.result }));
      },
    );

    expect(registry.registry.agentToolResultMiddlewares ?? []).toHaveLength(0);
    expect(diagnosticSummaries(registry.registry.diagnostics)).toEqual([
      {
        pluginId: "external-middleware",
        message: "plugin must be explicitly enabled to register agent tool result middleware",
      },
    ]);
  });

  it("keeps repeated middleware runtime and matcher scopes paired", async () => {
    const { config, registry } = createPluginRegistryFixture();
    const handler = vi.fn(
      (_event: AgentToolResultMiddlewareEvent, _ctx: AgentToolResultMiddlewareContext) => undefined,
    );
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "scoped-middleware",
        name: "Scoped Middleware",
        origin: "bundled",
        contracts: { agentToolResultMiddleware: ["openclaw", "codex"] },
      }),
      register(api) {
        api.registerAgentToolResultMiddleware(handler, {
          runtimes: ["codex"],
          matcher: ["exec"],
        });
        api.registerAgentToolResultMiddleware(handler, {
          runtimes: ["openclaw"],
          matcher: ["apply_patch"],
        });
      },
    });

    const registration = expectDefined(
      registry.registry.agentToolResultMiddlewares[0],
      "scoped middleware registration",
    );
    const event = {
      toolCallId: "call-1",
      args: {},
      result: { content: [{ type: "text" as const, text: "ok" }], details: {} },
    };
    await registration.handler({ ...event, toolName: "exec" }, { runtime: "codex" });
    await registration.handler({ ...event, toolName: "apply_patch" }, { runtime: "codex" });
    await registration.handler({ ...event, toolName: "apply_patch" }, { runtime: "openclaw" });
    await registration.handler({ ...event, toolName: "exec" }, { runtime: "openclaw" });

    expect(registry.registry.agentToolResultMiddlewares).toHaveLength(1);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls.map(([call, ctx]) => [call.toolName, ctx.runtime])).toEqual([
      ["exec", "codex"],
      ["apply_patch", "openclaw"],
    ]);
  });

  it("initializes a repeatedly registered Codex extension factory only once", async () => {
    const { config, registry } = createPluginRegistryFixture();
    const handler = vi.fn(() => undefined);
    const factory = vi.fn<CodexAppServerExtensionFactory>((runtime) => {
      runtime.on("tool_result", handler);
    });
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "deduplicated-factory",
        origin: "bundled",
        contracts: { embeddedExtensionFactories: ["codex-app-server"] },
      }),
      register(api) {
        api.registerCodexAppServerExtensionFactory(factory);
        api.registerCodexAppServerExtensionFactory(factory);
      },
    });
    try {
      const runner = createCodexAppServerToolResultExtensionRunner(
        {},
        registry.registry.codexAppServerExtensionFactories.map((entry) => entry.factory),
      );
      await runner.applyToolResultExtensions({
        threadId: "thread-1",
        turnId: "turn-1",
        toolCallId: "call-1",
        toolName: "read",
        args: {},
        result: { content: [{ type: "text", text: "ok" }], details: {} },
      });
      expect(factory).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      await disposePluginRegistryInstances(registry.registry);
    }
  });

  it("fences handlers from a retired managed Codex factory without claiming caller-owned factories", async () => {
    const { config, registry } = createPluginRegistryFixture();
    const managedHandler = vi.fn(() => undefined);
    const callerHandler = vi.fn(() => undefined);
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "managed-factory",
        origin: "bundled",
        contracts: { embeddedExtensionFactories: ["codex-app-server"] },
      }),
      register(api) {
        api.registerCodexAppServerExtensionFactory((runtime) => {
          runtime.on("tool_result", managedHandler);
        });
      },
    });
    const runner = createCodexAppServerToolResultExtensionRunner({}, [
      ...registry.registry.codexAppServerExtensionFactories.map((entry) => entry.factory),
      (runtime) => runtime.on("tool_result", callerHandler),
    ]);
    const event = {
      threadId: "thread-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      toolName: "read",
      args: {},
      result: { content: [{ type: "text" as const, text: "ok" }], details: {} },
    };
    try {
      await expect(runner.applyToolResultExtensions(event)).resolves.toEqual(event.result);
      expect(managedHandler).toHaveBeenCalledOnce();
      expect(callerHandler).toHaveBeenCalledOnce();
      await disposePluginRegistryInstances(registry.registry);
      await expect(runner.applyToolResultExtensions(event)).resolves.toEqual(event.result);
      expect(managedHandler).toHaveBeenCalledOnce();
      expect(callerHandler).toHaveBeenCalledTimes(2);
    } finally {
      await disposePluginRegistryInstances(registry.registry);
    }
  });

  it("diagnoses malformed trusted policy registrations", () => {
    const { registry } = registerFixture(
      {
        id: "malformed-policy",
        name: "Malformed Policy",
        origin: "workspace",
      },
      (api) => {
        Reflect.apply(api.registerTrustedToolPolicy, api, [null]);
        Reflect.apply(api.registerTrustedToolPolicy, api, [undefined]);
      },
    );

    expect(registry.registry.trustedToolPolicies).toHaveLength(0);
    expect(diagnosticSummaries(registry.registry.diagnostics)).toEqual([
      {
        pluginId: "malformed-policy",
        message: "trusted tool policy registration requires id, description, and evaluate()",
      },
      {
        pluginId: "malformed-policy",
        message: "trusted tool policy registration requires id, description, and evaluate()",
      },
    ]);
  });

  it("rejects duplicate trusted policy ids from the same plugin", () => {
    const { registry } = registerFixture(
      {
        id: "duplicate-policy",
        name: "Duplicate Policy",
        origin: "workspace",
        contracts: { trustedToolPolicies: ["workflow-budget"] },
      },
      (api) => {
        api.registerTrustedToolPolicy({
          id: "workflow-budget",
          description: "First workflow budget policy",
          evaluate: () => undefined,
        });
        api.registerTrustedToolPolicy({
          id: "workflow-budget",
          description: "Duplicate workflow budget policy",
          evaluate: () => undefined,
        });
      },
    );

    expect(registry.registry.trustedToolPolicies).toHaveLength(1);
    expect(diagnosticSummaries(registry.registry.diagnostics)).toEqual([
      {
        pluginId: "duplicate-policy",
        message: "trusted tool policy already registered: workflow-budget (duplicate-policy)",
      },
    ]);
  });

  it("keeps same-id bundled and installed trusted policies owner-scoped", async () => {
    const { config, registry } = registerFixture(
      {
        id: "external-policy",
        name: "External Policy",
        origin: "workspace",
        contracts: { trustedToolPolicies: ["shared-deny"] },
      },
      (api) => {
        api.registerTrustedToolPolicy({
          id: "shared-deny",
          description: "Declared external policy",
          evaluate: () => ({ allow: true }),
        });
      },
    );
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "bundled-policy",
        name: "Bundled Policy",
        origin: "bundled",
      }),
      register(api) {
        api.registerTrustedToolPolicy({
          id: "shared-deny",
          description: "Bundled policy",
          evaluate: () => ({ block: true, blockReason: "bundled policy" }),
        });
      },
    });
    setActivePluginRegistry(registry.registry);

    expect(
      registry.registry.trustedToolPolicies.map((entry) => [entry.pluginId, entry.policy.id]),
    ).toEqual([
      ["bundled-policy", "shared-deny"],
      ["external-policy", "shared-deny"],
    ]);
    expect(diagnosticSummaries(registry.registry.diagnostics)).toEqual([]);

    const result = await runTrustedToolPolicies(
      { toolName: "exec", params: {} },
      { toolName: "exec" },
    );

    expect(result?.blockReason).toBe("bundled policy");
  });

  it.each([
    {
      label: "official npm",
      origin: "global",
      packageName: undefined,
      rootDir: "/tmp/.openclaw/npm/node_modules/@openclaw/codex",
      allowed: true,
    },
    {
      label: "official ClawHub",
      origin: "global",
      packageName: "@openclaw/codex",
      rootDir: "/tmp/.openclaw/extensions/codex",
      allowed: true,
    },
    {
      label: "unofficial global",
      origin: "global",
      packageName: undefined,
      rootDir: "/tmp/.openclaw/extensions/codex",
      allowed: false,
    },
    {
      label: "workspace spoof",
      origin: "workspace",
      packageName: "@openclaw/codex",
      rootDir: "/tmp/workspace/codex",
      allowed: false,
    },
  ] as const)(
    "checks reserved /codex ownership for $label plugins",
    ({ origin, packageName, rootDir, allowed }) => {
      const { registry } = registerFixture(
        {
          id: "codex",
          name: "Codex",
          origin,
          packageName,
          rootDir,
          source: path.join(rootDir, "index.ts"),
        },
        (api) =>
          api.registerCommand({
            name: "codex",
            description: "Codex command",
            ownership: "reserved",
            handler: async () => ({ text: "ok" }),
          }),
      );
      const diagnostics = diagnosticSummaries(registry.registry.diagnostics);
      if (allowed) {
        expect(registry.registry.commands.map((entry) => entry.command.name)).toEqual(["codex"]);
        expect(
          diagnostics.some(
            (entry) =>
              entry.pluginId === "codex" &&
              entry.message?.includes("only bundled plugins can claim reserved command"),
          ),
        ).toBe(false);
      } else {
        expect(registry.registry.commands).toHaveLength(0);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]?.pluginId).toBe("codex");
        expect(diagnostics[0]?.message).toContain(
          "only bundled plugins can claim reserved command",
        );
      }
    },
  );

  it("rejects reserved command ownership for non-reserved bundled command names", () => {
    const { registry } = registerFixture(
      {
        id: "bundled-command",
        name: "Bundled Command",
        origin: "bundled",
      },
      (api) => {
        api.registerCommand({
          name: "workflow",
          description: "Should not need reserved ownership",
          ownership: "reserved",
          handler: async () => ({ text: "no" }),
        });
      },
    );

    expect(registry.registry.commands).toHaveLength(0);
    expect(diagnosticSummaries(registry.registry.diagnostics)).toEqual([
      {
        pluginId: "bundled-command",
        message: "reserved command ownership requires a reserved command name: workflow",
      },
    ]);
  });

  it("scopes trusted policies through canonical OpenClaw tool ids", async () => {
    const evaluate = vi.fn(() => ({ block: true, blockReason: "covered" }));
    const registry = createEmptyPluginRegistry();
    registry.trustedToolPolicies = [
      {
        pluginId: "shell-policy",
        source: "test",
        policy: {
          id: "shell-policy",
          description: "covers shell tools",
          matcher: ["exec"],
          evaluate,
        },
      },
    ];

    await expect(
      runTrustedToolPolicies(
        { toolName: "web_search", params: {} },
        { toolName: "web_search" },
        { registry },
      ),
    ).resolves.toBeUndefined();
    await expect(
      runTrustedToolPolicies({ toolName: "exec", params: {} }, { toolName: "exec" }, { registry }),
    ).resolves.toMatchObject({ block: true, blockReason: "covered" });
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it("fails closed before evaluating an unreadable trusted policy matcher", async () => {
    const matcher = "exec";
    const evaluate = vi.fn();
    const registry = createEmptyPluginRegistry();
    registry.trustedToolPolicies = [
      {
        pluginId: "fuzzplugin",
        source: "test",
        policy: {
          id: "fuzzpolicy",
          description: "synthetic trusted policy",
          matcher: matcher as never,
          evaluate,
        },
      },
    ];

    expect(getTrustedToolPolicyMatcherScope(registry)).toEqual({
      matchAll: true,
      toolNames: [],
    });
    await expect(
      runTrustedToolPolicies(
        { toolName: "web_search", params: {} },
        { toolName: "web_search" },
        { registry },
      ),
    ).resolves.toEqual({
      block: true,
      blockReason: "blocked by fuzzpolicy: policy matcher is unreadable",
    });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("fails closed when a trusted policy throws during evaluation", async () => {
    const registry = createEmptyPluginRegistry();
    registry.trustedToolPolicies = [
      {
        pluginId: "fuzzplugin",
        pluginName: "Fuzz Plugin",
        source: "test",
        policy: {
          id: "fuzzpolicy",
          description: "synthetic trusted policy",
          evaluate: () => {
            throw new Error("fuzzplugin trusted policy failed");
          },
        },
      },
    ];
    setActivePluginRegistry(registry);

    await expect(
      runTrustedToolPolicies({ toolName: "exec", params: {} }, { toolName: "exec" }),
    ).resolves.toEqual({
      block: true,
      blockReason: "blocked by fuzzpolicy: policy evaluation failed",
    });
  });

  it("fails closed when a trusted policy registration is unreadable", async () => {
    const registry = createEmptyPluginRegistry();
    const unreadableRegistration = {
      pluginId: "fuzzplugin",
      pluginName: "Fuzz Plugin",
      source: "test",
    };
    Object.defineProperty(unreadableRegistration, "policy", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin trusted policy is unreadable");
      },
    });
    registry.trustedToolPolicies = [unreadableRegistration as never];
    setActivePluginRegistry(registry);

    await expect(
      runTrustedToolPolicies({ toolName: "exec", params: {} }, { toolName: "exec" }),
    ).resolves.toEqual({
      block: true,
      blockReason: "blocked by fuzzplugin: policy is unreadable",
    });
  });

  it("fails closed when a trusted policy owner id is unreadable", async () => {
    const registry = createEmptyPluginRegistry();
    const unreadableOwnerRegistration = {
      pluginName: "Fuzz Plugin",
      source: "test",
      policy: {
        id: "fuzzpolicy",
        description: "synthetic trusted policy",
        evaluate: () => undefined,
      },
    };
    Object.defineProperty(unreadableOwnerRegistration, "pluginId", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin trusted policy owner is unreadable");
      },
    });
    registry.trustedToolPolicies = [unreadableOwnerRegistration as never];
    setActivePluginRegistry(registry);

    await expect(
      runTrustedToolPolicies({ toolName: "exec", params: {} }, { toolName: "exec" }),
    ).resolves.toEqual({
      block: true,
      blockReason: "blocked by fuzzpolicy: policy owner is unreadable",
    });
  });

  it("fails closed when a trusted policy decision is unreadable", async () => {
    const registry = createEmptyPluginRegistry();
    registry.trustedToolPolicies = [
      {
        pluginId: "fuzzplugin",
        pluginName: "Fuzz Plugin",
        source: "test",
        policy: {
          id: "fuzzpolicy",
          description: "synthetic trusted policy",
          evaluate: () =>
            Object.defineProperty({}, "allow", {
              enumerable: true,
              get() {
                throw new Error("fuzzplugin trusted policy allow is unreadable");
              },
            }),
        },
      },
    ];
    setActivePluginRegistry(registry);

    await expect(
      runTrustedToolPolicies({ toolName: "exec", params: {} }, { toolName: "exec" }),
    ).resolves.toEqual({
      block: true,
      blockReason: "blocked by fuzzpolicy: policy decision is unreadable",
    });
  });

  it("preserves cancellation while deriving a trusted policy rewrite", async () => {
    const controller = new AbortController();
    const abortError = new Error("aborted during rewrite derivation");
    const registry = policyRegistry(() => ({ params: { input: "rewritten" } }));

    await expect(
      runTrustedToolPolicies(
        { toolName: "apply_patch", params: { input: "original" } },
        { toolName: "apply_patch", abortSignal: controller.signal },
        {
          registry,
          deriveEvent: async () => {
            controller.abort(abortError);
            controller.signal.throwIfAborted();
            return {};
          },
        },
      ),
    ).rejects.toBe(abortError);
  });

  it("lets later trusted policy blocks override earlier approval requests", async () => {
    const registry = policyRegistry(
      () => ({
        requireApproval: {
          title: "Review",
          description: "Review the call",
        },
      }),
      () => ({ block: true, blockReason: "blocked by later policy" }),
    );
    setActivePluginRegistry(registry);

    await expect(
      runTrustedToolPolicies({ toolName: "exec", params: {} }, { toolName: "exec" }),
    ).resolves.toEqual({
      block: true,
      blockReason: "blocked by later policy",
    });
  });

  it("does not let trusted policies mutate derived paths for later policies", async () => {
    const seenDerivedPaths: unknown[] = [];
    let mutationRejected = false;
    const registry = policyRegistry(
      (event) => {
        try {
          (event.derivedPaths as string[] | undefined)?.push("mutated.ts");
        } catch {
          mutationRejected = true;
        }
        return undefined;
      },
      (event) => {
        seenDerivedPaths.push(event.derivedPaths);
        return undefined;
      },
    );
    setActivePluginRegistry(registry);

    await expect(
      runTrustedToolPolicies(
        {
          toolName: "apply_patch",
          params: { input: "*** Update File: old.ts" },
          derivedPaths: ["old.ts"],
        },
        { toolName: "apply_patch" },
      ),
    ).resolves.toBeUndefined();
    expect(mutationRejected).toBe(true);
    expect(seenDerivedPaths).toEqual([["old.ts"]]);
  });

  it("clears stale derived paths when trusted policy rewrites remove targets", async () => {
    const seenDerivedPaths: unknown[] = [];
    const registry = policyRegistry(
      () => ({ params: { input: "not a patch" } }),
      (event) => {
        seenDerivedPaths.push(event.derivedPaths);
        return undefined;
      },
    );
    setActivePluginRegistry(registry);

    await expect(
      runTrustedToolPolicies(
        {
          toolName: "apply_patch",
          params: { patch: "*** Update File: old.ts" },
          derivedPaths: ["old.ts"],
        },
        { toolName: "apply_patch" },
        {
          deriveEvent(params) {
            return typeof params.patch === "string" ? { derivedPaths: ["old.ts"] } : {};
          },
        },
      ),
    ).resolves.toEqual({ params: { input: "not a patch" } });
    expect(seenDerivedPaths).toEqual([undefined]);
  });

  it("does not let derived param callbacks override core trusted policy event fields", async () => {
    const seenEvents: Array<{ params: unknown; derivedPaths: unknown }> = [];
    const registry = policyRegistry(
      () => ({ params: { input: "*** Update File: new.ts" } }),
      (event) => {
        seenEvents.push({ params: event.params, derivedPaths: event.derivedPaths });
        return undefined;
      },
    );
    setActivePluginRegistry(registry);

    await expect(
      runTrustedToolPolicies(
        {
          toolName: "apply_patch",
          params: { input: "*** Update File: old.ts" },
          derivedPaths: ["old.ts"],
        },
        { toolName: "apply_patch" },
        {
          deriveEvent() {
            return {
              params: { input: "malicious override" },
              derivedPaths: ["new.ts"],
            } as never;
          },
        },
      ),
    ).resolves.toEqual({ params: { input: "*** Update File: new.ts" } });
    expect(seenEvents).toEqual([
      {
        params: { input: "*** Update File: new.ts" },
        derivedPaths: ["new.ts"],
      },
    ]);
  });

  it("validates plugin-owned JSON values as plain JSON-compatible data", () => {
    expect(
      isPluginJsonValue({
        state: "waiting",
        attempts: 1,
        nested: [{ ok: true }, null],
      }),
    ).toBe(true);
    expect(isPluginJsonValue({ value: Number.NaN })).toBe(false);
    expect(isPluginJsonValue({ value: undefined })).toBe(false);
    expect(isPluginJsonValue(new Date(0))).toBe(false);
    expect(isPluginJsonValue(new Map([["state", "waiting"]]))).toBe(false);
    expect(isPluginJsonValue({ value: "x".repeat(70 * 1024) })).toBe(false);
  });

  it("rejects non-JSON descriptor schemas before projecting Control UI descriptors", () => {
    const { registry } = registerFixture(
      {
        id: "descriptor-fixture",
        name: "Descriptor Fixture",
      },
      (api) => {
        api.registerControlUiDescriptor({
          id: "bad-schema",
          surface: "session",
          label: "Bad schema",
          schema: new Date(0) as never,
        });
      },
    );

    expect(registry.registry.controlUiDescriptors).toHaveLength(0);
    expect(diagnosticSummaries(registry.registry.diagnostics)).toEqual([
      {
        pluginId: "descriptor-fixture",
        message: "control UI descriptor schema must be JSON-compatible: bad-schema",
      },
    ]);
  });

  it("projects registered session extensions into gateway session rows", () => {
    const { config, registry } = createHostHookFixtureRegistry();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "host-hook-fixture",
        name: "Host Hook Fixture",
      }),
      register: registerHostHookFixture,
    });
    setActivePluginRegistry(registry.registry);

    const row = buildGatewaySessionRow({
      cfg: config,
      agentId: "main",
      storePath: "/tmp/sessions.json",
      store: {},
      key: "agent:main:main",
      entry: {
        sessionId: "session-1",
        updatedAt: 1,
        pluginExtensions: {
          "host-hook-fixture": {
            workflow: { state: "waiting" },
          },
        },
      },
    });

    expect(row.pluginExtensions).toEqual([
      {
        pluginId: "host-hook-fixture",
        namespace: "workflow",
        value: { state: "waiting" },
      },
    ]);
  });

  it("projects only successful synchronous session values without exposing raw state", () => {
    const { config, registry } = createPluginRegistryFixture();
    for (const [id, project] of [
      [
        "throwing",
        () => {
          throw new Error("projection failed");
        },
      ],
      ["promise", () => Promise.reject(new Error("projectors must be synchronous"))],
    ] as const) {
      registerTestPlugin({
        registry,
        config,
        record: createPluginRecord({ id }),
        register(api) {
          Reflect.apply(api.registerSessionExtension, api, [
            { namespace: "workflow", description: "Invalid projection", project },
          ]);
        },
      });
    }
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "projector-fixture",
        name: "Projector Fixture",
      }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "Projected workflow state",
          project: ({ state }) => {
            if (!state || typeof state !== "object" || Array.isArray(state)) {
              return undefined;
            }
            const workflowState = (state as { state?: unknown }).state;
            return typeof workflowState === "string" ? { state: workflowState } : undefined;
          },
        });
      },
    });
    setActivePluginRegistry(registry.registry);

    const entry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      pluginExtensions: {
        throwing: { workflow: "hidden" },
        promise: { workflow: "hidden" },
        "projector-fixture": {
          workflow: { state: "waiting", privateToken: "secret" },
        },
      },
    };
    expect(projectPluginSessionExtensionsSync({ sessionKey: "agent:main:main", entry })).toEqual([
      {
        pluginId: "projector-fixture",
        namespace: "workflow",
        value: { state: "waiting" },
      },
    ]);

    const row = buildGatewaySessionRow({
      cfg: config,
      agentId: "main",
      storePath: "/tmp/sessions.json",
      store: {},
      key: "agent:main:main",
      entry,
    });
    expect(row.pluginExtensions).toEqual([
      {
        pluginId: "projector-fixture",
        namespace: "workflow",
        value: { state: "waiting" },
      },
    ]);
  });

  it.each(["patch", "projection", "injection"] as const)(
    "uses the admitted registry for session %s after a new registry becomes globally active",
    async (operation) => {
      const createRegistry = (label: "global" | "scoped") => {
        const fixture = createPluginRegistryFixture();
        const record = createPluginRecord({ id: `${label}-owner` });
        registerTestPlugin({
          ...fixture,
          record,
          register(api) {
            api.registerSessionExtension({
              namespace: "workflow",
              description: "Scoped workflow state",
              sessionEntrySlotKey: `${label}Projection`,
              sessionEntrySlotSchema: { type: "object" },
              project: ({ state }) => ({ registry: label, state: state ?? null }),
            });
          },
        });
        return { ...fixture, instance: expectDefined(getPluginInstance(record), "plugin owner") };
      };
      const active = createRegistry("global");
      const scoped = createRegistry("scoped");
      setActivePluginRegistry(scoped.registry.registry);
      try {
        await withHostHookState(async ({ storePath, tempConfig }) => {
          const sessionKey = "agent:main:main";
          const access = { sessionKey, storePath };
          await replaceSessionEntry(access, {
            sessionId: "scoped-session",
            updatedAt: 1,
            pluginExtensions: { "scoped-owner": { workflow: "initial" } },
          });
          for (const label of ["global", "scoped"] as const) {
            await enqueuePluginNextTurnInjection({
              cfg: tempConfig,
              pluginId: `${label}-owner`,
              injection: { sessionKey, text: `${label} context` },
            });
          }
          const readEntry = () => expectDefined(loadSessionEntryReadOnly(access), "stored session");
          const admitted = createDeferredCore();
          const resume = createDeferredCore();
          const pending = scoped.instance.run(async () => {
            admitted.resolve();
            await resume.promise;
            if (operation === "patch") {
              const patch = {
                cfg: tempConfig,
                sessionKey,
                pluginId: "scoped-owner",
                namespace: "workflow",
                value: "updated",
              };
              await expect(patchPluginSessionExtension(patch)).resolves.toMatchObject({
                ok: true,
                value: "updated",
              });
              const stored = readEntry();
              expect(Reflect.get(stored, "scopedProjection")).toEqual({
                registry: "scoped",
                state: "updated",
              });
              expect(Reflect.get(stored, "globalProjection")).toBeUndefined();
              const failure = new Error("session mutation authority expired");
              await expect(
                patchPluginSessionExtension({
                  ...patch,
                  value: "must not commit",
                  assertCurrent: () => {
                    throw failure;
                  },
                }),
              ).rejects.toBe(failure);
              expect(readEntry()).toEqual(stored);
            } else if (operation === "projection") {
              expect(
                projectPluginSessionExtensionsSync({ sessionKey, entry: readEntry() }),
              ).toEqual([
                {
                  pluginId: "scoped-owner",
                  namespace: "workflow",
                  value: {
                    registry: "scoped",
                    state: "initial",
                  },
                },
              ]);
            } else {
              const result = await drainPluginNextTurnInjectionContext({
                cfg: tempConfig,
                sessionKey,
              });
              expect(result.prependContext).toBe("scoped context");
              expect(result.queuedInjections.map((entry) => entry.pluginId)).toEqual([
                "scoped-owner",
              ]);
              expect(readEntry().pluginNextTurnInjections).toBeUndefined();
            }
          });
          try {
            await admitted.promise;
            setActivePluginRegistry(active.registry.registry);
            expect(() => scoped.instance.run(() => undefined)).toThrow("reloaded or disabled");
            resume.resolve();
            await pending;
          } finally {
            resume.resolve();
            await pending.catch(() => undefined);
            await disposePluginRegistryInstances(scoped.registry.registry);
          }
        });
      } finally {
        await Promise.all([
          disposePluginRegistryInstances(scoped.registry.registry),
          disposePluginRegistryInstances(active.registry.registry),
        ]);
      }
    },
  );

  it("rejects async session extension projectors because gateway rows are synchronous", () => {
    const { registry } = registerFixture(
      {
        id: "async-projector-fixture",
        name: "Async Projector Fixture",
      },
      (api) => {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "Async workflow state",
          project: (async () => ({ state: "late" })) as unknown as () => undefined,
        });
      },
    );

    expect(registry.registry.sessionExtensions).toHaveLength(0);
    expect(diagnosticSummaries(registry.registry.diagnostics)).toEqual([
      {
        pluginId: "async-projector-fixture",
        message: "session extension projector must be synchronous",
      },
    ]);
  });

  it("reports specific diagnostics for malformed session extension callbacks", () => {
    const { registry } = registerFixture(
      {
        id: "bad-session-extension-fixture",
        name: "Bad Session Extension Fixture",
      },
      (api) => {
        api.registerSessionExtension({
          namespace: "projector",
          description: "Bad projector",
          project: "not-a-function" as never,
        });
        api.registerSessionExtension({
          namespace: "cleanup",
          description: "Bad cleanup",
          cleanup: "not-a-function" as never,
        });
      },
    );

    expect(registry.registry.sessionExtensions).toHaveLength(0);
    expect(diagnosticSummaries(registry.registry.diagnostics)).toEqual([
      {
        pluginId: "bad-session-extension-fixture",
        message: "session extension projector must be a function",
      },
      {
        pluginId: "bad-session-extension-fixture",
        message: "session extension cleanup must be a function",
      },
    ]);
  });

  it("rejects duplicate runtime lifecycle and agent event subscription ids", () => {
    const { registry } = registerFixture(
      {
        id: "duplicate-host-hook-fixture",
        name: "Duplicate Host Hook Fixture",
      },
      (api) => {
        api.registerRuntimeLifecycle({ id: "cleanup", cleanup: () => undefined });
        api.registerRuntimeLifecycle({ id: "cleanup", cleanup: () => undefined });
        api.registerRuntimeLifecycle({
          id: "bad-cleanup",
          cleanup: "not-a-function" as never,
        });
        api.registerAgentEventSubscription({
          id: "events",
          streams: ["tool"],
          handle: () => undefined,
        });
        api.registerAgentEventSubscription({
          id: "events",
          streams: ["error"],
          handle: () => undefined,
        });
        api.registerAgentEventSubscription({
          id: "missing-handler",
          streams: ["tool"],
          handle: "not-a-function" as never,
        });
        api.registerAgentEventSubscription({
          id: "bad-streams",
          streams: { length: 1, 0: "tool" } as never,
          handle: () => undefined,
        });
        api.registerSessionSchedulerJob({
          id: "bad-scheduler-cleanup",
          sessionKey: "agent:main:main",
          kind: "monitor",
          cleanup: "not-a-function" as never,
        });
      },
    );

    expect(registry.registry.runtimeLifecycles).toHaveLength(1);
    expect(registry.registry.agentEventSubscriptions).toHaveLength(1);
    expect(diagnosticSummaries(registry.registry.diagnostics)).toEqual([
      {
        pluginId: "duplicate-host-hook-fixture",
        message: "runtime lifecycle already registered: cleanup",
      },
      {
        pluginId: "duplicate-host-hook-fixture",
        message: "runtime lifecycle cleanup must be a function: bad-cleanup",
      },
      {
        pluginId: "duplicate-host-hook-fixture",
        message: "agent event subscription already registered: events",
      },
      {
        pluginId: "duplicate-host-hook-fixture",
        message: "agent event subscription registration requires id and handle",
      },
      {
        pluginId: "duplicate-host-hook-fixture",
        message: "agent event subscription streams must be an array of strings: bad-streams",
      },
      {
        pluginId: "duplicate-host-hook-fixture",
        message: "session scheduler job cleanup must be a function: bad-scheduler-cleanup",
      },
    ]);
  });

  it("requires explicit unset to remove plugin session extension state", async () => {
    const { registry } = registerFixture(
      {
        id: "patch-fixture",
        name: "Patch Fixture",
      },
      (api) => {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "Patch workflow state",
        });
      },
    );
    setActivePluginRegistry(registry.registry);

    await withHostHookState(async ({ storePath, tempConfig }) => {
      await updateSessionStore(storePath, (store) => {
        store["agent:main:main"] = {
          sessionId: "session-1",
          updatedAt: Date.now(),
          pluginExtensions: {
            "patch-fixture": { workflow: { state: "waiting" } },
          },
        };
        return undefined;
      });

      await expect(
        patchPluginSessionExtension({
          cfg: tempConfig,
          sessionKey: "agent:main:main",
          pluginId: "patch-fixture",
          namespace: "workflow",
        }),
      ).resolves.toEqual({
        ok: false,
        error: "plugin session extension value is required unless unset is true",
      });
      expect(
        loadSessionStore(storePath)["agent:main:main"]?.pluginExtensions?.["patch-fixture"]
          ?.workflow,
      ).toEqual({ state: "waiting" });

      await expect(
        patchPluginSessionExtension({
          cfg: tempConfig,
          sessionKey: "agent:main:main",
          pluginId: "patch-fixture",
          namespace: "workflow",
          value: { state: "ambiguous" },
          unset: true,
        }),
      ).resolves.toEqual({
        ok: false,
        error: "plugin session extension cannot specify both unset and value",
      });
      expect(
        loadSessionStore(storePath)["agent:main:main"]?.pluginExtensions?.["patch-fixture"]
          ?.workflow,
      ).toEqual({ state: "waiting" });

      await expect(
        patchPluginSessionExtension({
          cfg: tempConfig,
          sessionKey: "agent:main:main",
          pluginId: "patch-fixture",
          namespace: "workflow",
          value: { state: "approved" },
        }),
      ).resolves.toEqual({
        ok: true,
        key: "agent:main:main",
        value: { state: "approved" },
      });

      await expect(
        patchPluginSessionExtension({
          cfg: tempConfig,
          sessionKey: "agent:main:main",
          pluginId: "patch-fixture",
          namespace: "workflow",
          unset: true,
        }),
      ).resolves.toEqual({
        ok: true,
        key: "agent:main:main",
        value: undefined,
      });
      expect(loadSessionStore(storePath)["agent:main:main"]?.pluginExtensions).toBeUndefined();
    });
  });

  it("keeps global plugin extension state in its selected agent store", async () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(createPluginRecord({ id: "owner-fixture", status: "loaded" }));
    registry.sessionExtensions.push({
      pluginId: "owner-fixture",
      source: "test",
      extension: { namespace: "workflow", description: "Agent-owned workflow state" },
    });
    registry.trustedToolPolicies.push({
      pluginId: "owner-fixture",
      source: "test",
      policy: {
        id: "owner-state",
        description: "Read the selected agent's workflow state",
        evaluate: (_event, ctx) => ({
          params: { workflow: ctx.getSessionExtension?.("workflow") },
        }),
      },
    });
    setActivePluginRegistry(registry);
    await withHostHookState(
      async ({ tempConfig }) => {
        const scope = (agentId: string) => ({
          agentId,
          sessionKey: "global",
          storePath: resolveSessionStorePathCore(tempConfig.session.store, { agentId }),
        });
        for (const agentId of ["qa", "beta"]) {
          await replaceSessionEntry(scope(agentId), {
            sessionId: `session-${agentId}`,
            updatedAt: 1,
            pluginExtensions: { "owner-fixture": { workflow: { owner: agentId } } },
            pluginNextTurnInjections: {
              "owner-fixture": [
                {
                  id: agentId,
                  pluginId: "owner-fixture",
                  text: agentId,
                  placement: "prepend_context",
                  createdAt: 1,
                },
              ],
            },
          });
        }
        const betaBefore = loadSessionEntryReadOnly(scope("beta"));
        await expect(
          patchPluginSessionExtension({
            cfg: tempConfig,
            agentId: "qa",
            sessionKey: "global",
            pluginId: "owner-fixture",
            namespace: "workflow",
            value: { owner: "qa", approved: true },
          }),
        ).resolves.toMatchObject({ ok: true });
        expect(
          getPluginSessionExtensionStateSync({
            cfg: tempConfig,
            agentId: "qa",
            sessionKey: "global",
            pluginId: "owner-fixture",
          }),
        ).toEqual({ workflow: { owner: "qa", approved: true } });
        await expect(
          runTrustedToolPolicies(
            { toolName: "read", params: {} },
            { toolName: "read", sessionKey: "global", agentId: "qa" },
            { config: tempConfig, registry },
          ),
        ).resolves.toEqual({ params: { workflow: { owner: "qa", approved: true } } });
        expect(loadSessionEntryReadOnly(scope("beta"))).toEqual(betaBefore);
      },
      (storePath) => ({
        agents: { ownership: "explicit", entries: { qa: {}, beta: {} } },
        session: { store: path.join(path.dirname(storePath), "{agentId}", "sessions.json") },
      }),
    );
  });

  it("models queued next-turn injections and agent_turn_prepare as one prompt context", async () => {
    const { config, registry } = createHostHookFixtureRegistry();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "host-hook-fixture",
        name: "Host Hook Fixture",
      }),
      register: registerHostHookFixture,
    });
    const runner = createHookRunner(registry.registry);
    const queuedContext = buildPluginAgentTurnPrepareContext({
      queuedInjections: [
        {
          id: "approval",
          pluginId: "approval-plugin",
          text: "approval workflow resumed",
          placement: "prepend_context",
          createdAt: 1,
        },
        {
          id: "budget",
          pluginId: "budget-plugin",
          text: "budget policy summary",
          placement: "append_context",
          createdAt: 1,
        },
      ],
    });
    const hookContext = await runner.runAgentTurnPrepare(
      {
        prompt: "continue",
        messages: [],
        queuedInjections: [],
      },
      { sessionKey: "agent:main:main" },
    );

    expect(
      joinContextFragments(
        queuedContext.prependContext,
        queuedContext.appendContext,
        hookContext?.prependContext,
      ),
    ).toContain("approval workflow resumed");
    expect(hookContext?.prependContext).toBe("fixture turn context");
  });

  it("skips malformed persisted next-turn injection records during prompt assembly", () => {
    const queuedContext = buildPluginAgentTurnPrepareContext({
      queuedInjections: [
        {
          id: "bad-text",
          pluginId: "approval-plugin",
          text: 123,
          placement: "prepend_context",
          createdAt: 1,
        } as never,
        {
          id: "bad-placement",
          pluginId: "approval-plugin",
          text: "wrong placement",
          placement: "middle_context",
          createdAt: 1,
        } as never,
        {
          id: "valid",
          pluginId: "approval-plugin",
          text: "  approval workflow resumed  ",
          placement: "append_context",
          createdAt: 1,
        },
      ],
    });

    expect(queuedContext).toEqual({ appendContext: "approval workflow resumed" });
  });

  it("rejects malformed next-turn injection input before persisting records", async () => {
    await expect(
      enqueuePluginNextTurnInjection({
        cfg: {},
        pluginId: "approval-fixture",
        injection: {
          sessionKey: "agent:main:main",
          text: "invalid placement",
          placement: "middle_context",
        } as never,
      }),
    ).resolves.toEqual({ enqueued: false, id: "", sessionKey: "agent:main:main" });

    await expect(
      enqueuePluginNextTurnInjection({
        cfg: {},
        pluginId: "approval-fixture",
        injection: {
          sessionKey: "agent:main:main",
          text: "invalid ttl",
          ttlMs: Number.POSITIVE_INFINITY,
        },
      }),
    ).resolves.toEqual({ enqueued: false, id: "", sessionKey: "agent:main:main" });

    await expect(
      enqueuePluginNextTurnInjection({
        cfg: {},
        pluginId: "approval-fixture",
        injection: {
          sessionKey: "agent:main:main",
          text: "negative ttl",
          ttlMs: -1,
        },
      }),
    ).resolves.toEqual({ enqueued: false, id: "", sessionKey: "agent:main:main" });
  });

  it("reports duplicate next-turn injections as not newly enqueued", async () => {
    await withHostHookState(async ({ storePath, tempConfig }) => {
      await updateSessionStore(storePath, (store) => {
        store["agent:main:main"] = {
          sessionId: "session-1",
          updatedAt: Date.now(),
        };
        return undefined;
      });
      const now = Date.now();

      const first = await enqueuePluginNextTurnInjection({
        cfg: tempConfig,
        pluginId: "approval-fixture",
        injection: {
          sessionKey: "agent:main:main",
          text: "resume approval workflow",
          placement: "prepend_context",
          idempotencyKey: "approval:resume",
        },
        now,
      });
      const duplicate = await enqueuePluginNextTurnInjection({
        cfg: tempConfig,
        pluginId: "approval-fixture",
        injection: {
          sessionKey: "agent:main:main",
          text: "resume approval workflow again",
          placement: "prepend_context",
          idempotencyKey: "approval:resume",
        },
        now: now + 1,
      });

      expect(first.enqueued).toBe(true);
      expect(duplicate).toEqual({
        enqueued: false,
        id: first.id,
        sessionKey: "agent:main:main",
      });
      const stored = loadSessionStore(storePath, { skipCache: true });
      expect(
        stored["agent:main:main"]?.pluginNextTurnInjections?.["approval-fixture"],
      ).toHaveLength(1);
    });
  });

  it("suppresses stale next-turn injections from plugins that are no longer loaded", async () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      createPluginRecord({
        id: "active-injector",
        name: "Active Injector",
        status: "loaded",
      }),
      createPluginRecord({
        id: "disabled-injector",
        name: "Disabled Injector",
        status: "disabled",
      }),
      createPluginRecord({
        id: "policy-blocked-injector",
        name: "Policy Blocked Injector",
        status: "loaded",
      }),
    );
    setActivePluginRegistry(registry);
    await withHostHookState(
      async ({ storePath, tempConfig }) => {
        await updateSessionStore(storePath, (store) => {
          store["agent:main:main"] = {
            sessionId: "session-1",
            updatedAt: Date.now(),
            pluginNextTurnInjections: {
              "active-injector": [
                {
                  id: "active",
                  pluginId: "active-injector",
                  text: "active prompt contribution",
                  placement: "append_context",
                  createdAt: 1,
                },
              ],
              "disabled-injector": [
                {
                  id: "stale",
                  pluginId: "disabled-injector",
                  text: "stale prompt contribution",
                  placement: "prepend_context",
                  createdAt: 1,
                },
              ],
              "policy-blocked-injector": [
                {
                  id: "policy-blocked",
                  pluginId: "policy-blocked-injector",
                  text: "policy blocked prompt contribution",
                  placement: "prepend_context",
                  createdAt: 1,
                },
              ],
            },
          };
          return undefined;
        });

        const { queuedInjections: drained } = await drainPluginNextTurnInjectionContext({
          cfg: tempConfig,
          sessionKey: "agent:main:main",
          now: 2,
        });
        expect(drained).toHaveLength(1);
        expectRecordFields(drained[0], {
          id: "active",
          pluginId: "active-injector",
          text: "active prompt contribution",
        });
        const stored = loadSessionStore(storePath, { skipCache: true });
        expect(stored["agent:main:main"]?.pluginNextTurnInjections).toBeUndefined();
      },
      (storePath) => ({
        session: { store: storePath },
        plugins: {
          entries: {
            "policy-blocked-injector": {
              hooks: { allowPromptInjection: false },
            },
          },
        },
      }),
    );
  });

  it("preserves global enqueue order when draining live next-turn injections", async () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      createPluginRecord({
        id: "injector-a",
        name: "Injector A",
        status: "loaded",
      }),
      createPluginRecord({
        id: "injector-b",
        name: "Injector B",
        status: "loaded",
      }),
    );
    setActivePluginRegistry(registry);
    await withHostHookState(async ({ storePath, tempConfig }) => {
      await updateSessionStore(storePath, (store) => {
        store["agent:main:main"] = {
          sessionId: "session-1",
          updatedAt: Date.now(),
          pluginNextTurnInjections: {
            "injector-a": [
              {
                id: "a1",
                pluginId: "injector-a",
                text: "first",
                placement: "append_context",
                createdAt: 1,
              },
              {
                id: "a2",
                pluginId: "injector-a",
                text: "third",
                placement: "append_context",
                createdAt: 3,
              },
            ],
            "injector-b": [
              {
                id: "b1",
                pluginId: "injector-b",
                text: "second",
                placement: "append_context",
                createdAt: 2,
              },
            ],
          },
        };
        return undefined;
      });

      const { queuedInjections: drained } = await drainPluginNextTurnInjectionContext({
        cfg: tempConfig,
        sessionKey: "agent:main:main",
        now: 4,
      });
      expect(drained).toHaveLength(3);
      expectRecordFields(drained[0], { id: "a1", text: "first" });
      expectRecordFields(drained[1], { id: "b1", text: "second" });
      expectRecordFields(drained[2], { id: "a2", text: "third" });
    });
  });

  it("projects plugin UI descriptor metadata through the strict gateway result shape", () => {
    const { config, registry } = registerFixture(
      {
        id: "host-hook-fixture",
        name: "Host Hook Fixture",
      },
      (api) => {
        api.registerControlUiDescriptor({
          id: "approval-panel",
          surface: "session",
          label: "Approval panel",
        });
        api.registerControlUiDescriptor({
          id: "admin-panel",
          surface: "settings",
          label: "Admin panel",
          requiredScopes: ["operator.admin"],
        });
      },
    );
    const descriptorEntry = registry.registry.controlUiDescriptors[0];
    if (!descriptorEntry) {
      throw new Error("expected control UI descriptor registration");
    }
    Object.assign(descriptorEntry.descriptor, { leakedRegistryField: true });
    setActivePluginRegistry(registry.registry);

    const methodRegistry = createGatewayMethodRegistry(
      createCoreGatewayMethodDescriptors(pluginHostHookHandlers),
      registry.registry,
    );
    const context: Pick<GatewayRequestContext, "getRuntimeConfig" | "getGatewayMethodRegistry"> = {
      getRuntimeConfig: () => config,
      getGatewayMethodRegistry: () => methodRegistry,
    };
    const calls: Array<[boolean, unknown, unknown]> = [];
    void expectDefined(
      pluginHostHookHandlers["plugins.uiDescriptors"],
      'pluginHostHookHandlers["plugins.uiDescriptors"] test invariant',
    )({
      req: { type: "req", id: "ui-descriptors", method: "plugins.uiDescriptors", params: {} },
      params: {},
      client: {
        connect: {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: { id: "gateway-client", version: "test", platform: "test", mode: "backend" },
          scopes: [ADMIN_SCOPE],
        },
      },
      isWebchatConnect: () => false,
      context: context as GatewayRequestContext,
      respond: (ok: boolean, payload: unknown, error: unknown) => {
        calls.push([ok, payload, error]);
      },
    });

    expect(calls).toHaveLength(1);
    const [ok, payload, error] = calls[0] ?? [];
    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(validatePluginsUiDescriptorsResult(payload)).toBe(true);
    expect(payload).toEqual(hostHookUiProjection(getActivePluginRegistryVersion()));
  });

  it("enforces command requiredScopes for gateway clients and command owners", async () => {
    const handlerCalls: string[] = [];
    const { config, registry } = registerFixture(
      {
        id: "approval-command-fixture",
        name: "Approval Command Fixture",
      },
      (api) => {
        api.registerCommand({
          name: "approval-fixture",
          description: "Continue the agent after approval.",
          requiredScopes: [APPROVALS_SCOPE],
          acceptsArgs: true,
          handler: async (ctx) => {
            handlerCalls.push(ctx.args ?? "");
            return { text: "approval queued", continueAgent: true };
          },
        });
      },
    );
    const registration = requireFirstCommandRegistration(registry.registry);
    const command = {
      ...registration.command,
      pluginId: registration.pluginId,
      pluginName: registration.pluginName,
      pluginRoot: registration.rootDir,
    };
    expect(
      registerPluginCommandInRegistry(registry.registry, "invalid-command-fixture", {
        name: "invalid-scopes-fixture",
        description: "Invalid scopes.",
        requiredScopes: "operator.approvals" as never,
        handler: () => ({ text: "unused" }),
      }).error,
    ).toBe("Command requiredScopes must be an array of operator scopes");
    expect(
      registerPluginCommandInRegistry(registry.registry, "invalid-command-fixture", {
        name: "unknown-scopes-fixture",
        description: "Unknown scopes.",
        requiredScopes: ["operator.unknown" as never],
        handler: () => ({ text: "unused" }),
      }).error,
    ).toBe("Command requiredScopes contains unknown operator scope: operator.unknown");
    expect(
      registerPluginCommandInRegistry(registry.registry, "invalid-command-fixture", {
        name: "invalid-owner-status-fixture",
        description: "Invalid owner status exposure.",
        exposeSenderIsOwner: "yes" as never,
        handler: () => ({ text: "unused" }),
      }).error,
    ).toBe("Command exposeSenderIsOwner must be a boolean");

    await expect(
      executePluginCommand({
        command,
        args: "resume-text",
        senderId: "owner",
        channel: "whatsapp",
        isAuthorizedSender: true,
        senderIsOwner: true,
        sessionKey: "agent:main:main",
        commandBody: "/approval-fixture resume-text",
        config,
      }),
    ).resolves.toEqual({ text: "approval queued", continueAgent: true });
    expect(handlerCalls).toEqual(["resume-text"]);

    await expect(
      executePluginCommand({
        command,
        args: "resume",
        senderId: "owner",
        channel: "whatsapp",
        isAuthorizedSender: true,
        gatewayClientScopes: [READ_SCOPE, WRITE_SCOPE],
        sessionKey: "agent:main:main",
        commandBody: "/approval-fixture resume",
        config,
      }),
    ).resolves.toEqual({
      text: `⚠️ This command requires gateway scope: ${APPROVALS_SCOPE}.`,
    });
    expect(handlerCalls).toEqual(["resume-text"]);

    await expect(
      executePluginCommand({
        command,
        args: "resume",
        senderId: "owner",
        channel: "whatsapp",
        isAuthorizedSender: true,
        gatewayClientScopes: [APPROVALS_SCOPE],
        sessionKey: "agent:main:main",
        commandBody: "/approval-fixture resume",
        config,
      }),
    ).resolves.toEqual({ text: "approval queued", continueAgent: true });
    expect(handlerCalls).toEqual(["resume-text", "resume"]);
  });

  it("continues agent event dispatch and terminal cleanup when one subscription throws", async () => {
    const { config, registry } = createHostHookFixtureRegistry();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "throwing-subscription",
        name: "Throwing Subscription",
      }),
      register(api) {
        api.registerAgentEventSubscription({
          id: "throws",
          streams: ["tool"],
          handle() {
            throw new Error("subscription failed");
          },
        });
      },
    });
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({ id: "host-hook-fixture" }),
      register: registerHostHookFixture,
    });
    setActivePluginRegistry(registry.registry);

    emitAgentEvent({
      runId: "run-throws",
      stream: "tool",
      data: { name: "approval_fixture_tool" },
    });
    await Promise.resolve();

    expect(
      getPluginRunContext({
        pluginId: "host-hook-fixture",
        get: { runId: "run-throws", namespace: "lastToolEvent" },
      }),
    ).toEqual({ runId: "run-throws", seen: true });

    emitAgentEvent({
      runId: "run-throws",
      stream: "lifecycle",
      data: { phase: "end" },
    });
    await waitForPluginEventHandlers();

    expect(
      getPluginRunContext({
        pluginId: "host-hook-fixture",
        get: { runId: "run-throws", namespace: "lastToolEvent" },
      }),
    ).toBeUndefined();
  });

  it("cleans plugin-owned session state and lifecycle resources on reset/disable", async () => {
    const cleanupEvents: string[] = [];
    const { registry } = registerFixture(
      {
        id: "cleanup-fixture",
        name: "Cleanup Fixture",
      },
      (api) => {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "cleanup test",
          cleanup: ({ reason, sessionKey }) => {
            cleanupEvents.push(`session:${reason}:${sessionKey ?? ""}`);
          },
        });
        api.registerRuntimeLifecycle({
          id: "monitor",
          cleanup: ({ reason, sessionKey }) => {
            cleanupEvents.push(`runtime:${reason}:${sessionKey ?? ""}`);
          },
        });
        api.registerSessionSchedulerJob({
          id: "nudge",
          sessionKey: "agent:main:main",
          kind: "monitor",
          cleanup: ({ reason, sessionKey }) => {
            cleanupEvents.push(`scheduler:${reason}:${sessionKey}`);
          },
        });
      },
    );
    setActivePluginRegistry(registry.registry);

    const entry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      pluginExtensions: {
        "cleanup-fixture": { workflow: { state: "waiting" } },
        "other-plugin": { workflow: { state: "keep" } },
      },
      pluginNextTurnInjections: {
        "cleanup-fixture": [
          {
            id: "resume",
            pluginId: "cleanup-fixture",
            text: "resume",
            placement: "prepend_context" as const,
            createdAt: 1,
          },
        ],
        "other-plugin": [
          {
            id: "keep",
            pluginId: "other-plugin",
            text: "keep",
            placement: "append_context" as const,
            createdAt: 1,
          },
        ],
      },
    };
    clearPluginOwnedSessionState(entry, "cleanup-fixture");
    expect(entry.pluginExtensions).toEqual({
      "other-plugin": { workflow: { state: "keep" } },
    });
    expect(entry.pluginNextTurnInjections).toEqual({
      "other-plugin": [
        {
          id: "keep",
          pluginId: "other-plugin",
          text: "keep",
          placement: "append_context",
          createdAt: 1,
        },
      ],
    });

    await withHostHookState(async ({ tempConfig }) => {
      await runPluginHostCleanup({
        cfg: tempConfig,
        registry: registry.registry,
        pluginId: "cleanup-fixture",
        reason: "reset",
        sessionKey: "agent:main:main",
      });
      const next = createEmptyPluginRegistry();
      stageActivePluginRegistry(next, null, "default");
      await createPluginHostRegistryRetirement({
        cfg: tempConfig,
        previousRegistry: registry.registry,
        nextRegistry: next,
      })();
    });

    expect(cleanupEvents).toEqual([
      "session:reset:agent:main:main",
      "runtime:reset:agent:main:main",
      "scheduler:reset:agent:main:main",
      "session:disable:",
      "runtime:disable:",
    ]);
    expect(listPluginSessionSchedulerJobs("cleanup-fixture")).toStrictEqual([]);
  });

  it("keeps scheduler job records when cleanup fails so cleanup can retry", async () => {
    const cleanup = vi.fn<() => void>().mockImplementationOnce(() => {
      throw new Error("cleanup failed");
    });
    const { config, registry } = registerFixture(
      {
        id: "cleanup-failure-fixture",
        name: "Cleanup Failure Fixture",
      },
      (api) => {
        api.registerSessionSchedulerJob({
          id: "retryable-job",
          sessionKey: "agent:main:main",
          kind: "monitor",
          cleanup,
        });
      },
    );
    setActivePluginRegistry(registry.registry);

    const cleanupResult = await runPluginHostCleanup({
      cfg: config,
      registry: registry.registry,
      pluginId: "cleanup-failure-fixture",
      reason: "disable",
    });
    expect(cleanupResult.failures).toHaveLength(1);
    expectRecordFields(cleanupResult.failures[0], {
      pluginId: "cleanup-failure-fixture",
      hookId: "scheduler:retryable-job",
    });
    expect(listPluginSessionSchedulerJobs("cleanup-failure-fixture")).toEqual([
      {
        id: "retryable-job",
        pluginId: "cleanup-failure-fixture",
        sessionKey: "agent:main:main",
        kind: "monitor",
      },
    ]);
    await expect(
      runPluginHostCleanup({
        cfg: config,
        registry: registry.registry,
        pluginId: "cleanup-failure-fixture",
        reason: "disable",
      }),
    ).resolves.toEqual({ cleanupCount: 0, failures: [] });
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(listPluginSessionSchedulerJobs("cleanup-failure-fixture")).toEqual([]);
  });

  it("does not invoke old scheduler cleanup for a preserved newer generation", async () => {
    const cleanupEvents: string[] = [];
    const previousFixture = createPluginRegistryFixture();
    registerTestPlugin({
      registry: previousFixture.registry,
      config: previousFixture.config,
      record: createPluginRecord({
        id: "scheduler-preserve",
        name: "Scheduler Preserve",
      }),
      register(api) {
        api.registerSessionSchedulerJob({
          id: "shared-job",
          sessionKey: "agent:main:main",
          kind: "monitor",
          cleanup: ({ reason, jobId }) => {
            cleanupEvents.push(`${reason}:${jobId}`);
          },
        });
      },
    });
    setActivePluginRegistry(previousFixture.registry.registry);

    const replacementFixture = createPluginRegistryFixture();
    registerTestPlugin({
      registry: replacementFixture.registry,
      config: replacementFixture.config,
      record: createPluginRecord({
        id: "scheduler-preserve",
        name: "Scheduler Preserve",
      }),
      register(api) {
        api.registerSessionSchedulerJob({
          id: "shared-job",
          sessionKey: "agent:main:main",
          kind: "monitor",
        });
      },
    });

    stageActivePluginRegistry(replacementFixture.registry.registry, null, "default");
    await expect(
      createPluginHostRegistryRetirement({
        cfg: previousFixture.config,
        previousRegistry: previousFixture.registry.registry,
        nextRegistry: replacementFixture.registry.registry,
      })(),
    ).resolves.toEqual({ cleanupCount: 0, failures: [] });
    expect(cleanupEvents).toEqual([]);
    expect(listPluginSessionSchedulerJobs("scheduler-preserve")).toEqual([
      {
        id: "shared-job",
        pluginId: "scheduler-preserve",
        sessionKey: "agent:main:main",
        kind: "monitor",
      },
    ]);
  });

  it("does not let stale scheduler cleanup delete a newer job generation", async () => {
    const cleanupStarted = createDeferredCore();
    const finishCleanup = createDeferredCore();
    const previousFixture = createPluginRegistryFixture();
    registerTestPlugin({
      registry: previousFixture.registry,
      config: previousFixture.config,
      record: createPluginRecord({
        id: "scheduler-race",
        name: "Scheduler Race",
      }),
      register(api) {
        api.registerSessionSchedulerJob({
          id: "shared-job",
          sessionKey: "agent:main:main",
          kind: "monitor",
          cleanup: async () => {
            cleanupStarted.resolve();
            await finishCleanup.promise;
          },
        });
      },
    });
    setActivePluginRegistry(previousFixture.registry.registry);

    const next = createEmptyPluginRegistry();
    stageActivePluginRegistry(next, null, "default");
    const cleanupPromise = createPluginHostRegistryRetirement({
      cfg: previousFixture.config,
      previousRegistry: previousFixture.registry.registry,
      nextRegistry: next,
    })();
    try {
      await Promise.race([
        cleanupStarted.promise,
        cleanupPromise.then((result) => {
          expect(result.failures).toEqual([]);
          throw new Error("Expected scheduler cleanup to start before retirement settled");
        }),
      ]);

      const replacementFixture = createPluginRegistryFixture();
      registerTestPlugin({
        registry: replacementFixture.registry,
        config: replacementFixture.config,
        record: createPluginRecord({
          id: "scheduler-race",
          name: "Scheduler Race",
        }),
        register(api) {
          api.registerSessionSchedulerJob({
            id: "shared-job",
            sessionKey: "agent:main:main",
            kind: "monitor",
          });
        },
      });
      setActivePluginRegistry(replacementFixture.registry.registry);

      finishCleanup.resolve();
      const cleanupResult = await cleanupPromise;
      expect(cleanupResult.failures).toEqual([]);
      expect(listPluginSessionSchedulerJobs("scheduler-race")).toEqual([
        {
          id: "shared-job",
          pluginId: "scheduler-race",
          sessionKey: "agent:main:main",
          kind: "monitor",
        },
      ]);
    } finally {
      finishCleanup.resolve();
      await cleanupPromise;
    }
  });
  it("does not register scheduler jobs globally during non-activating registry loads", () => {
    const registry = createPluginRegistry({
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      runtime: {} as PluginRuntime,
      activateGlobalSideEffects: false,
    });
    const config = {};
    let handle:
      | {
          id: string;
          pluginId: string;
          sessionKey: string;
          kind: string;
        }
      | undefined;
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "snapshot-fixture",
        name: "Snapshot Fixture",
      }),
      register(api) {
        handle = api.registerSessionSchedulerJob({
          id: "snapshot-job",
          sessionKey: "agent:main:main",
          kind: "monitor",
        });
      },
    });

    expect(handle).toEqual({
      id: "snapshot-job",
      pluginId: "snapshot-fixture",
      sessionKey: "agent:main:main",
      kind: "monitor",
    });
    const schedulerJobs = registry.registry.sessionSchedulerJobs;
    expect(schedulerJobs).toHaveLength(1);
    const schedulerJob = schedulerJobs[0];
    expect(schedulerJob?.pluginId).toBe("snapshot-fixture");
    expectRecordFields(schedulerJob?.job, {
      id: "snapshot-job",
      sessionKey: "agent:main:main",
      kind: "monitor",
    });
    expect(listPluginSessionSchedulerJobs("snapshot-fixture")).toStrictEqual([]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
