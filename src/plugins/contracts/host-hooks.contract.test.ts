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
import { resolveSessionStorePathCore, type SessionEntry } from "../../config/sessions.js";
import {
  clearPluginOwnedSessionState,
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
import { registerPluginCommandInRegistry } from "../command-registration.js";
import { executePluginCommand } from "../commands.js";
import { createHookRunner } from "../hooks.js";
import { createPluginHostRegistryRetirement, runPluginHostCleanup } from "../host-hook-cleanup.js";
import { getPluginRunContext } from "../host-hook-runtime.js";
import { listPluginSessionSchedulerJobs } from "../host-hook-runtime.test-fixtures.js";
import {
  drainPluginNextTurnInjectionContext,
  enqueuePluginNextTurnInjection,
  getPluginSessionExtensionState,
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
import type { OpenClawPluginApi } from "../types.js";
import { registerHostHookFixture } from "./host-hook-fixture.js";
import { hostHookUiProjection } from "./test-helpers/host-hook-ui-projection.js";

async function waitForPluginEventHandlers(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function createHostHookFixtureRegistry() {
  return createPluginRegistryFixture({
    plugins: { entries: { "host-hook-fixture": { hooks: { allowConversationAccess: true } } } },
  });
}

function registerFixture(
  record: string | Parameters<typeof createPluginRecord>[0],
  register: Parameters<typeof registerTestPlugin>[0]["register"],
) {
  const fixture = createPluginRegistryFixture();
  registerInto(fixture, typeof record === "string" ? { id: record } : record, register);
  return fixture;
}

function registerInto(
  fixture: Pick<Parameters<typeof registerTestPlugin>[0], "registry" | "config">,
  record: Parameters<typeof createPluginRecord>[0],
  register: Parameters<typeof registerTestPlugin>[0]["register"],
) {
  registerTestPlugin({ ...fixture, record: createPluginRecord(record), register });
}

function injection(
  pluginId: string,
  id: string,
  text: string,
  placement: "append_context" | "prepend_context" = "append_context",
  createdAt = 1,
) {
  return { pluginId, id, text, placement, createdAt };
}

function activateInjectors(...plugins: Array<[id: string, status?: "loaded" | "disabled"]>) {
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(
    ...plugins.map(([id, status = "loaded"]) => createPluginRecord({ id, status })),
  );
  setActivePluginRegistry(registry);
}

function inspectionRegistry() {
  return createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });
}

const sharedJob = { id: "shared-job", sessionKey: "agent:main:main", kind: "monitor" };

function schedulerFixture(
  id: string,
  name: string,
  cleanup?: Parameters<OpenClawPluginApi["registerSessionSchedulerJob"]>[0]["cleanup"],
) {
  return registerFixture({ id, name }, (api) => {
    api.registerSessionSchedulerJob({ ...sharedJob, cleanup });
  });
}

function expectDiagnostics(
  registry: ReturnType<typeof createPluginRegistryFixture>["registry"]["registry"],
  pluginId: string,
  ...messages: string[]
) {
  expect(diagnosticSummaries(registry.diagnostics)).toEqual(
    messages.map((message) => ({ pluginId, message })),
  );
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

function makePolicy(
  id: string,
  evaluate: PluginTrustedToolPolicyRegistration["evaluate"] = () => undefined,
): PluginTrustedToolPolicyRegistration {
  return { id, description: "Fixture policy", evaluate };
}

function sessionExtension(
  overrides: Partial<Parameters<OpenClawPluginApi["registerSessionExtension"]>[0]> = {},
) {
  return { namespace: "workflow", description: "Fixture workflow state", ...overrides };
}

function runPolicy(
  event: Parameters<typeof runTrustedToolPolicies>[0] = { toolName: "exec", params: {} },
  options?: Parameters<typeof runTrustedToolPolicies>[2],
) {
  return runTrustedToolPolicies(event, { toolName: event.toolName }, options);
}

function requireFirstCommandRegistration(
  registry: ReturnType<typeof createPluginRegistryFixture>["registry"]["registry"],
) {
  return expectDefined(registry.commands[0], "first plugin command registration");
}

function diagnosticSummaries(diagnostics: readonly unknown[]) {
  return diagnostics.map((entry) => {
    const diagnostic = entry as { pluginId?: string; message?: string };
    return { pluginId: diagnostic.pluginId, message: diagnostic.message };
  });
}

function loadSession(storePath: string) {
  return loadSessionEntryReadOnly({ agentId: "main", sessionKey: "agent:main:main", storePath });
}

async function seedSession(storePath: string, fields: Partial<SessionEntry> = {}): Promise<void> {
  await replaceSessionEntry(
    { sessionKey: "agent:main:main", storePath },
    {
      sessionId: "session-1",
      updatedAt: Date.now(),
      ...fields,
    },
  );
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
    registerInto(
      { registry, config },
      {
        id: "host-hook-fixture",
        name: "Host Hook Fixture",
        origin: "workspace",
        contracts: { tools: ["approval_fixture_tool"] },
      },
      registerHostHookFixture,
    );

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
    expectDiagnostics(
      registry.registry,
      "external-middleware",
      "plugin must be explicitly enabled to register agent tool result middleware",
    );
  });

  it("keeps repeated middleware runtime and matcher scopes paired", async () => {
    const { config, registry } = createPluginRegistryFixture();
    const handler = vi.fn(
      (_event: AgentToolResultMiddlewareEvent, _ctx: AgentToolResultMiddlewareContext) => undefined,
    );
    registerInto(
      { registry, config },
      {
        id: "scoped-middleware",
        name: "Scoped Middleware",
        origin: "bundled",
        contracts: { agentToolResultMiddleware: ["openclaw", "codex"] },
      },
      (api) => {
        api.registerAgentToolResultMiddleware(handler, {
          runtimes: ["codex"],
          matcher: ["exec"],
        });
        api.registerAgentToolResultMiddleware(handler, {
          runtimes: ["openclaw"],
          matcher: ["apply_patch"],
        });
      },
    );

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

  it.each([
    {
      scenario: "malformed registrations",
      record: { id: "malformed-policy", name: "Malformed Policy", origin: "workspace" as const },
      policies: [null, undefined],
      accepted: 0,
      messages: [
        "trusted tool policy registration requires id, description, and evaluate()",
        "trusted tool policy registration requires id, description, and evaluate()",
      ],
    },
    {
      scenario: "duplicate ids",
      record: {
        id: "duplicate-policy",
        name: "Duplicate Policy",
        origin: "workspace" as const,
        contracts: { trustedToolPolicies: ["workflow-budget"] },
      },
      policies: [makePolicy("workflow-budget"), makePolicy("workflow-budget")],
      accepted: 1,
      messages: ["trusted tool policy already registered: workflow-budget (duplicate-policy)"],
    },
    {
      scenario: "missing explicit opt-in",
      record: {
        id: "external-policy",
        name: "External Policy",
        origin: "workspace" as const,
        contracts: { trustedToolPolicies: ["deny"] },
        explicitlyEnabled: false,
        activationSource: "default" as const,
      },
      policies: [
        makePolicy("deny", () => ({ block: true, blockReason: "blocked by external policy" })),
      ],
      accepted: 0,
      messages: ["plugin must be explicitly enabled to register trusted tool policy: deny"],
    },
  ])("diagnoses trusted policy $scenario", ({ record, policies, accepted, messages }) => {
    const { registry } = registerFixture(record, (api) => {
      for (const policy of policies) {
        if (policy == null) {
          Reflect.apply(api.registerTrustedToolPolicy, api, [policy]);
        } else {
          api.registerTrustedToolPolicy(policy);
        }
      }
    });

    expect(registry.registry.trustedToolPolicies).toHaveLength(accepted);
    expectDiagnostics(registry.registry, record.id, ...messages);
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
        api.registerTrustedToolPolicy(makePolicy("shared-deny", () => ({ allow: true })));
      },
    );
    registerInto(
      { registry, config },
      {
        id: "bundled-policy",
        name: "Bundled Policy",
        origin: "bundled",
      },
      (api) => {
        api.registerTrustedToolPolicy(
          makePolicy("shared-deny", () => ({ block: true, blockReason: "bundled policy" })),
        );
      },
    );
    setActivePluginRegistry(registry.registry);

    expect(
      registry.registry.trustedToolPolicies.map((entry) => [entry.pluginId, entry.policy.id]),
    ).toEqual([
      ["bundled-policy", "shared-deny"],
      ["external-policy", "shared-deny"],
    ]);
    expect(diagnosticSummaries(registry.registry.diagnostics)).toEqual([]);

    expect((await runPolicy())?.blockReason).toBe("bundled policy");
  });

  it.each([
    ["official npm", "global", undefined, "/tmp/.openclaw/npm/node_modules/@openclaw/codex", true],
    ["official ClawHub", "global", "@openclaw/codex", "/tmp/.openclaw/extensions/codex", true],
    ["unofficial global", "global", undefined, "/tmp/.openclaw/extensions/codex", false],
    ["workspace spoof", "workspace", "@openclaw/codex", "/tmp/workspace/codex", false],
  ] as const)(
    "checks reserved /codex ownership for %s plugins",
    (_label, origin, packageName, rootDir, allowed) => {
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
        expect(diagnostics).toEqual([
          {
            pluginId: "codex",
            message: expect.stringContaining("only bundled plugins can claim reserved command"),
          },
        ]);
      }
    },
  );

  it("rejects reserved command ownership for non-reserved bundled command names", () => {
    const { registry } = registerFixture({ id: "bundled-command", origin: "bundled" }, (api) => {
      api.registerCommand({
        name: "workflow",
        description: "Should not need reserved ownership",
        ownership: "reserved",
        handler: async () => ({ text: "no" }),
      });
    });

    expect(registry.registry.commands).toHaveLength(0);
    expectDiagnostics(
      registry.registry,
      "bundled-command",
      "reserved command ownership requires a reserved command name: workflow",
    );
  });

  it("scopes trusted policies through canonical OpenClaw tool ids", async () => {
    const evaluate = vi.fn(() => ({ block: true, blockReason: "covered" }));
    const registry = policyRegistry(evaluate);
    expectDefined(registry.trustedToolPolicies[0], "trusted policy").policy.matcher = ["exec"];

    using matcherCopies = vi.spyOn(Array, "from");
    await expect(
      runPolicy({ toolName: "web_search", params: {} }, { registry }),
    ).resolves.toBeUndefined();
    await expect(runPolicy(undefined, { registry })).resolves.toMatchObject({
      block: true,
      blockReason: "covered",
    });
    expect(evaluate).toHaveBeenCalledOnce();
    expect(
      matcherCopies.mock.calls.filter(([value]) => value instanceof Set && value.has("exec")),
    ).toHaveLength(2);
  });

  it.each([
    { failure: "matcher", reason: "policy matcher is unreadable" },
    { failure: "evaluation", reason: "policy evaluation failed" },
    { failure: "policy", reason: "policy is unreadable" },
    { failure: "pluginId", reason: "policy owner is unreadable" },
    { failure: "decision", reason: "policy decision is unreadable" },
  ])("fails closed for a trusted policy $failure failure", async ({ failure, reason }) => {
    const evaluate = vi.fn(() => {
      if (failure === "evaluation") {
        throw new Error("fuzzplugin trusted policy failed");
      }
      if (failure === "decision") {
        return Object.defineProperty({}, "allow", {
          enumerable: true,
          get() {
            throw new Error("fuzzplugin trusted policy allow is unreadable");
          },
        });
      }
      return undefined;
    });
    const registry = createEmptyPluginRegistry();
    const registration = {
      pluginId: "fuzzplugin",
      pluginName: "Fuzz Plugin",
      source: "test",
      policy: {
        ...makePolicy("fuzzpolicy", evaluate),
        ...(failure === "matcher" ? { matcher: "exec" as never } : {}),
      },
    };
    if (failure === "policy" || failure === "pluginId") {
      Object.defineProperty(registration, failure, {
        enumerable: true,
        get() {
          throw new Error(`fuzzplugin trusted policy ${failure} is unreadable`);
        },
      });
    }
    registry.trustedToolPolicies = [registration];
    setActivePluginRegistry(registry);
    if (failure === "matcher") {
      expect(getTrustedToolPolicyMatcherScope(registry)).toEqual({
        matchAll: true,
        toolNames: [],
      });
    }

    const toolName = failure === "matcher" ? "web_search" : "exec";
    await expect(runPolicy({ toolName, params: {} })).resolves.toEqual({
      block: true,
      blockReason: `blocked by ${failure === "policy" ? "fuzzplugin" : "fuzzpolicy"}: ${reason}`,
    });
    expect(evaluate).toHaveBeenCalledTimes(
      failure === "evaluation" || failure === "decision" ? 1 : 0,
    );
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

    await expect(runPolicy()).resolves.toEqual({
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
      runPolicy({
        toolName: "apply_patch",
        params: { input: "*** Update File: old.ts" },
        derivedPaths: ["old.ts"],
      }),
    ).resolves.toBeUndefined();
    expect(mutationRejected).toBe(true);
    expect(seenDerivedPaths).toEqual([["old.ts"]]);
  });

  it.each([
    {
      scenario: "clears stale paths after targets disappear",
      originalParams: { patch: "*** Update File: old.ts" },
      input: "not a patch",
      deriveEvent: (params: Record<string, unknown>) =>
        typeof params.patch === "string" ? { derivedPaths: ["old.ts"] } : {},
      expectedPaths: undefined,
    },
    {
      scenario: "ignores attempts to override core event fields",
      originalParams: { input: "*** Update File: old.ts" },
      input: "*** Update File: new.ts",
      deriveEvent: () => ({ params: { input: "malicious override" }, derivedPaths: ["new.ts"] }),
      expectedPaths: ["new.ts"],
    },
  ])(
    "derives trusted policy rewrites: $scenario",
    async ({ originalParams, input, deriveEvent, expectedPaths }) => {
      const seenEvents: Array<{ params: unknown; derivedPaths: unknown }> = [];
      const registry = policyRegistry(
        () => ({ params: { input } }),
        (event) => {
          seenEvents.push({ params: event.params, derivedPaths: event.derivedPaths });
          return undefined;
        },
      );
      setActivePluginRegistry(registry);

      await expect(
        runPolicy(
          {
            toolName: "apply_patch",
            params: originalParams,
            derivedPaths: ["old.ts"],
          },
          { deriveEvent },
        ),
      ).resolves.toEqual({ params: { input } });
      expect(seenEvents).toEqual([
        {
          params: { input },
          derivedPaths: expectedPaths,
        },
      ]);
    },
  );

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
    const { registry } = registerFixture("descriptor-fixture", (api) => {
      api.registerControlUiDescriptor({
        id: "bad-schema",
        surface: "session",
        label: "Bad schema",
        schema: new Date(0) as never,
      });
    });

    expect(registry.registry.controlUiDescriptors).toHaveLength(0);
    expectDiagnostics(
      registry.registry,
      "descriptor-fixture",
      "control UI descriptor schema must be JSON-compatible: bad-schema",
    );
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
      registerInto({ registry, config }, { id }, (api) => {
        Reflect.apply(api.registerSessionExtension, api, [{ ...sessionExtension(), project }]);
      });
    }
    registerInto({ registry, config }, { id: "projector-fixture" }, (api) => {
      api.registerSessionExtension(sessionExtension({ namespace: "raw" }));
      api.registerSessionExtension(
        sessionExtension({
          project: ({ state }) => {
            if (!state || typeof state !== "object" || Array.isArray(state)) {
              return undefined;
            }
            const workflowState = (state as { state?: unknown }).state;
            return typeof workflowState === "string" ? { state: workflowState } : undefined;
          },
        }),
      );
    });
    setActivePluginRegistry(registry.registry);

    const entry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      pluginExtensions: {
        throwing: { workflow: "hidden" },
        promise: { workflow: "hidden" },
        "projector-fixture": {
          raw: { state: "waiting" },
          workflow: { state: "waiting", privateToken: "secret" },
        },
      },
    };
    const expected = [
      {
        pluginId: "projector-fixture",
        namespace: "raw",
        value: { state: "waiting" },
      },
      {
        pluginId: "projector-fixture",
        namespace: "workflow",
        value: { state: "waiting" },
      },
    ];
    expect(projectPluginSessionExtensionsSync({ sessionKey: "agent:main:main", entry })).toEqual(
      expected,
    );

    const row = buildGatewaySessionRow({
      cfg: config,
      agentId: "main",
      storePath: "/tmp/sessions.json",
      store: {},
      key: "agent:main:main",
      entry,
    });
    expect(row.pluginExtensions).toEqual(expected);
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
            api.registerSessionExtension(
              sessionExtension({
                sessionEntrySlotKey: `${label}Projection`,
                sessionEntrySlotSchema: { type: "object" },
                project: ({ state }) => ({ registry: label, state: state ?? null }),
              }),
            );
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

  it.each([
    {
      callbacks: { project: (async () => ({ state: "late" })) as unknown as () => undefined },
      message: "session extension projector must be synchronous",
    },
    {
      callbacks: { project: "not-a-function" as never },
      message: "session extension projector must be a function",
    },
    {
      callbacks: { cleanup: "not-a-function" as never },
      message: "session extension cleanup must be a function",
    },
  ])("rejects invalid session callbacks: $message", ({ callbacks, message }) => {
    const { registry } = registerFixture("bad-session-extension-fixture", (api) => {
      api.registerSessionExtension(sessionExtension(callbacks));
    });

    expect(registry.registry.sessionExtensions).toHaveLength(0);
    expectDiagnostics(registry.registry, "bad-session-extension-fixture", message);
  });

  it("rejects duplicate runtime lifecycle and agent event subscription ids", () => {
    const { registry } = registerFixture("duplicate-host-hook-fixture", (api) => {
      api.registerRuntimeLifecycle({ id: "cleanup", cleanup: () => undefined });
      api.registerRuntimeLifecycle({ id: "cleanup", cleanup: () => undefined });
      api.registerRuntimeLifecycle({
        id: "bad-cleanup",
        cleanup: "not-a-function" as never,
      });
      for (const subscription of [
        { id: "events", streams: ["tool"] },
        { id: "events", streams: ["error"] },
        { id: "missing-handler", streams: ["tool"], handle: "not-a-function" as never },
        { id: "bad-streams", streams: { length: 1, 0: "tool" } as never },
      ]) {
        api.registerAgentEventSubscription({ handle: () => undefined, ...subscription });
      }
      api.registerSessionSchedulerJob({
        id: "bad-scheduler-cleanup",
        sessionKey: "agent:main:main",
        kind: "monitor",
        cleanup: "not-a-function" as never,
      });
    });

    expect(registry.registry.runtimeLifecycles).toHaveLength(1);
    expect(registry.registry.agentEventSubscriptions).toHaveLength(1);
    expectDiagnostics(
      registry.registry,
      "duplicate-host-hook-fixture",
      "runtime lifecycle already registered: cleanup",
      "runtime lifecycle cleanup must be a function: bad-cleanup",
      "agent event subscription already registered: events",
      "agent event subscription registration requires id and handle",
      "agent event subscription streams must be an array of strings: bad-streams",
      "session scheduler job cleanup must be a function: bad-scheduler-cleanup",
    );
  });

  it.each([
    {
      options: { phases: "start" as never },
      field: "phases",
      requirement: "an array of non-empty strings",
    },
    { options: { phases: [" "] }, field: "phases", requirement: "an array of non-empty strings" },
    {
      options: { phases: [1] as never },
      field: "phases",
      requirement: "an array of non-empty strings",
    },
    { options: { payload: "summary" as never }, field: "payload", requirement: "full or metadata" },
  ])("rejects malformed agent event $field: $options", ({ options, field, requirement }) => {
    const { registry } = registerFixture({ id: "bad-event" }, (api) => {
      api.agent.events.registerAgentEventSubscription({
        id: "events",
        ...options,
        handle: () => undefined,
      });
    });
    expect(registry.registry.agentEventSubscriptions).toHaveLength(0);
    expectDiagnostics(
      registry.registry,
      "bad-event",
      `agent event subscription ${field} must be ${requirement}: events`,
    );
  });

  it("requires explicit unset to remove plugin session extension state", async () => {
    const { registry } = registerFixture("patch-fixture", (api) => {
      api.registerSessionExtension(sessionExtension());
    });
    setActivePluginRegistry(registry.registry);

    await withHostHookState(async ({ storePath, tempConfig }) => {
      await seedSession(storePath, {
        pluginExtensions: {
          "patch-fixture": { workflow: { state: "waiting" } },
        },
      });

      const patch = (
        change: Pick<Parameters<typeof patchPluginSessionExtension>[0], "value" | "unset"> = {},
      ) =>
        patchPluginSessionExtension({
          cfg: tempConfig,
          sessionKey: "agent:main:main",
          pluginId: "patch-fixture",
          namespace: "workflow",
          ...change,
        });
      const readWorkflow = () =>
        loadSession(storePath)?.pluginExtensions?.["patch-fixture"]?.workflow;
      await expect(patch()).resolves.toEqual({
        ok: false,
        error: "plugin session extension value is required unless unset is true",
      });
      expect(readWorkflow()).toEqual({ state: "waiting" });

      await expect(patch({ value: { state: "ambiguous" }, unset: true })).resolves.toEqual({
        ok: false,
        error: "plugin session extension cannot specify both unset and value",
      });
      expect(readWorkflow()).toEqual({ state: "waiting" });

      await expect(patch({ value: { state: "approved" } })).resolves.toEqual({
        ok: true,
        key: "agent:main:main",
        value: { state: "approved" },
      });

      await expect(patch({ unset: true })).resolves.toEqual({
        ok: true,
        key: "agent:main:main",
        value: undefined,
      });
      expect(loadSession(storePath)?.pluginExtensions).toBeUndefined();
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
              "owner-fixture": [injection("owner-fixture", agentId, agentId, "prepend_context")],
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
          await getPluginSessionExtensionState({
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

  it("skips malformed persisted next-turn injection records during prompt assembly", () => {
    const queuedContext = buildPluginAgentTurnPrepareContext({
      queuedInjections: [
        { ...injection("approval-plugin", "bad-text", "", "prepend_context"), text: 123 } as never,
        {
          ...injection("approval-plugin", "bad-placement", "wrong placement"),
          placement: "middle_context",
        } as never,
        injection("approval-plugin", "valid", "  approval workflow resumed  "),
      ],
    });

    expect(queuedContext).toEqual({ appendContext: "approval workflow resumed" });
  });

  it("rejects malformed next-turn injection input before persisting records", async () => {
    for (const invalid of [
      { placement: "middle_context" as never },
      { ttlMs: Infinity },
      { ttlMs: -1 },
    ]) {
      await expect(
        enqueuePluginNextTurnInjection({
          cfg: {},
          pluginId: "approval-fixture",
          injection: { sessionKey: "agent:main:main", text: "invalid", ...invalid },
        }),
      ).resolves.toEqual({ enqueued: false, id: "", sessionKey: "agent:main:main" });
    }
  });

  it("reports duplicate next-turn injections as not newly enqueued", async () => {
    await withHostHookState(async ({ storePath, tempConfig }) => {
      await seedSession(storePath);
      const now = Date.now();

      const enqueue = (text: string, timestamp: number) =>
        enqueuePluginNextTurnInjection({
          cfg: tempConfig,
          pluginId: "approval-fixture",
          injection: {
            sessionKey: "agent:main:main",
            text,
            placement: "prepend_context",
            idempotencyKey: "approval:resume",
          },
          now: timestamp,
        });
      const first = await enqueue("resume approval workflow", now);
      const duplicate = await enqueue("resume approval workflow again", now + 1);

      expect(first.enqueued).toBe(true);
      expect(duplicate).toEqual({
        enqueued: false,
        id: first.id,
        sessionKey: "agent:main:main",
      });
      expect(loadSession(storePath)?.pluginNextTurnInjections?.["approval-fixture"]).toHaveLength(
        1,
      );
    });
  });

  it("suppresses stale next-turn injections from plugins that are no longer loaded", async () => {
    activateInjectors(
      ["active-injector"],
      ["disabled-injector", "disabled"],
      ["policy-blocked-injector"],
    );
    await withHostHookState(
      async ({ storePath, tempConfig }) => {
        await seedSession(storePath, {
          pluginNextTurnInjections: {
            "active-injector": [
              injection("active-injector", "active", "active prompt contribution"),
            ],
            "disabled-injector": [
              injection("disabled-injector", "stale", "stale", "prepend_context"),
            ],
            "policy-blocked-injector": [
              injection("policy-blocked-injector", "blocked", "blocked", "prepend_context"),
            ],
          },
        });

        const { queuedInjections: drained } = await drainPluginNextTurnInjectionContext({
          cfg: tempConfig,
          sessionKey: "agent:main:main",
        });
        expect(drained).toHaveLength(1);
        expect(drained[0]).toMatchObject({
          id: "active",
          pluginId: "active-injector",
          text: "active prompt contribution",
        });
        expect(loadSession(storePath)?.pluginNextTurnInjections).toBeUndefined();
      },
      (storePath) => ({
        session: { store: storePath },
        plugins: {
          entries: { "policy-blocked-injector": { hooks: { allowPromptInjection: false } } },
        },
      }),
    );
  });

  it("preserves global enqueue order when draining live next-turn injections", async () => {
    activateInjectors(["injector-a"], ["injector-b"]);
    await withHostHookState(async ({ storePath, tempConfig }) => {
      await seedSession(storePath, {
        pluginNextTurnInjections: {
          "injector-a": [
            injection("injector-a", "a1", "first"),
            injection("injector-a", "a2", "third", "append_context", 3),
          ],
          "injector-b": [injection("injector-b", "b1", "second", "append_context", 2)],
        },
      });

      const { queuedInjections: drained } = await drainPluginNextTurnInjectionContext({
        cfg: tempConfig,
        sessionKey: "agent:main:main",
      });
      expect(drained.map(({ id, text }) => ({ id, text }))).toEqual([
        { id: "a1", text: "first" },
        { id: "b1", text: "second" },
        { id: "a2", text: "third" },
      ]);
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
    const { config, registry } = registerFixture("approval-command-fixture", (api) => {
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
    });
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

    const execute = (
      args: string,
      authority: Pick<
        Parameters<typeof executePluginCommand>[0],
        "senderIsOwner" | "gatewayClientScopes"
      >,
    ) =>
      executePluginCommand({
        command,
        args,
        senderId: "owner",
        channel: "whatsapp",
        isAuthorizedSender: true,
        sessionKey: "agent:main:main",
        commandBody: `/approval-fixture ${args}`,
        config,
        ...authority,
      });
    await expect(execute("resume-text", { senderIsOwner: true })).resolves.toEqual({
      text: "approval queued",
      continueAgent: true,
    });
    expect(handlerCalls).toEqual(["resume-text"]);

    await expect(
      execute("resume", { gatewayClientScopes: [READ_SCOPE, WRITE_SCOPE] }),
    ).resolves.toEqual({
      text: `⚠️ This command requires gateway scope: ${APPROVALS_SCOPE}.`,
    });
    expect(handlerCalls).toEqual(["resume-text"]);

    await expect(execute("resume", { gatewayClientScopes: [APPROVALS_SCOPE] })).resolves.toEqual({
      text: "approval queued",
      continueAgent: true,
    });
    expect(handlerCalls).toEqual(["resume-text", "resume"]);
  });

  it("continues agent event dispatch and terminal cleanup when one subscription throws", async () => {
    const { config, registry } = createHostHookFixtureRegistry();
    registerInto({ registry, config }, { id: "throwing-subscription" }, (api) => {
      api.registerAgentEventSubscription({
        id: "throws",
        streams: ["tool"],
        handle() {
          throw new Error("subscription failed");
        },
      });
    });
    registerInto(
      { registry, config },
      {
        id: "host-hook-fixture",
        contracts: { tools: ["approval_fixture_tool"] },
      },
      registerHostHookFixture,
    );
    setActivePluginRegistry(registry.registry);
    const readLastToolEvent = () =>
      getPluginRunContext({
        pluginId: "host-hook-fixture",
        get: { runId: "run-throws", namespace: "lastToolEvent" },
      });

    emitAgentEvent({
      runId: "run-throws",
      stream: "tool",
      data: { name: "approval_fixture_tool" },
    });
    await Promise.resolve();

    expect(readLastToolEvent()).toEqual({ runId: "run-throws", seen: true });

    emitAgentEvent({
      runId: "run-throws",
      stream: "lifecycle",
      data: { phase: "end" },
    });
    await waitForPluginEventHandlers();

    expect(readLastToolEvent()).toBeUndefined();
  });

  it("cleans plugin-owned session state and lifecycle resources on reset/disable", async () => {
    const cleanupEvents: string[] = [];
    const { registry } = registerFixture("cleanup-fixture", (api) => {
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
    });
    setActivePluginRegistry(registry.registry);

    const entry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      pluginExtensions: {
        "cleanup-fixture": { workflow: { state: "waiting" } },
        "other-plugin": { workflow: { state: "keep" } },
      },
      pluginNextTurnInjections: {
        "cleanup-fixture": [injection("cleanup-fixture", "resume", "resume", "prepend_context")],
        "other-plugin": [injection("other-plugin", "keep", "keep")],
      },
    };
    clearPluginOwnedSessionState(entry, "cleanup-fixture");
    expect(entry.pluginExtensions).toEqual({
      "other-plugin": { workflow: { state: "keep" } },
    });
    expect(entry.pluginNextTurnInjections).toEqual({
      "other-plugin": [injection("other-plugin", "keep", "keep")],
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
    const { config, registry } = registerFixture("cleanup-failure-fixture", (api) => {
      api.registerSessionSchedulerJob({
        id: "retryable-job",
        sessionKey: "agent:main:main",
        kind: "monitor",
        cleanup,
      });
    });
    setActivePluginRegistry(registry.registry);

    const runCleanup = () =>
      runPluginHostCleanup({
        cfg: config,
        registry: registry.registry,
        pluginId: "cleanup-failure-fixture",
        reason: "disable",
      });
    const cleanupResult = await runCleanup();
    expect(cleanupResult.failures).toHaveLength(1);
    expect(cleanupResult.failures[0]).toMatchObject({
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
    await expect(runCleanup()).resolves.toEqual({ cleanupCount: 0, failures: [] });
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(listPluginSessionSchedulerJobs("cleanup-failure-fixture")).toEqual([]);
  });

  it("does not invoke old scheduler cleanup for a preserved newer generation", async () => {
    const cleanupEvents: string[] = [];
    const previousFixture = schedulerFixture(
      "scheduler-preserve",
      "Scheduler Preserve",
      ({ reason, jobId }) => {
        cleanupEvents.push(`${reason}:${jobId}`);
      },
    );
    setActivePluginRegistry(previousFixture.registry.registry);

    const replacementFixture = schedulerFixture("scheduler-preserve", "Scheduler Preserve");

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
      { ...sharedJob, pluginId: "scheduler-preserve" },
    ]);
  });

  it("does not let stale scheduler cleanup delete a newer job generation", async () => {
    const cleanupStarted = createDeferredCore();
    const finishCleanup = createDeferredCore();
    const previousFixture = schedulerFixture("scheduler-race", "Scheduler Race", async () => {
      cleanupStarted.resolve();
      await finishCleanup.promise;
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

      const replacementFixture = schedulerFixture("scheduler-race", "Scheduler Race");
      setActivePluginRegistry(replacementFixture.registry.registry);

      finishCleanup.resolve();
      const cleanupResult = await cleanupPromise;
      expect(cleanupResult.failures).toEqual([]);
      expect(listPluginSessionSchedulerJobs("scheduler-race")).toEqual([
        { ...sharedJob, pluginId: "scheduler-race" },
      ]);
    } finally {
      finishCleanup.resolve();
      await cleanupPromise;
    }
  });
  it("shares run context from admitted scoped hooks with the global service only", async () => {
    const id = "run-context-bridge";
    const config = { plugins: { entries: { [id]: { hooks: { allowConversationAccess: true } } } } };
    const root = createPluginRegistryFixture(config);
    const scoped = inspectionRegistry();
    let rootApi!: OpenClawPluginApi;
    let scopedApi!: OpenClawPluginApi;
    let observing = false;
    const observations: unknown[] = [];
    const writes: boolean[] = [];
    const reads: unknown[] = [];
    const service = {
      id: "observer",
      start: () => {
        observing = true;
      },
      stop: () => {
        observing = false;
      },
    };
    const runId = "scoped-run-context";
    const params = { runId, namespace: "admission" };
    registerTestPlugin({
      ...root,
      record: createPluginRecord({ id }),
      register(api) {
        rootApi = api;
        api.registerService(service);
        api.agent.events.registerAgentEventSubscription({
          id: "observer",
          streams: ["tool"],
          handle(_event, ctx) {
            if (observing) {
              observations.push(ctx.getRunContext("admission"));
            }
          },
        });
      },
    });
    registerTestPlugin({
      registry: scoped,
      config,
      record: createPluginRecord({ id }),
      register(api) {
        scopedApi = api;
        api.on("llm_input", () => {
          writes.push(api.runContext.setRunContext({ ...params, value: { admitted: true } }));
          reads.push(api.runContext.getRunContext(params));
          api.runContext.clearRunContext(params);
          reads.push(api.runContext.getRunContext(params));
          api.runContext.setRunContext({ ...params, value: { admitted: true } });
        });
      },
    });
    setActivePluginRegistry(root.registry.registry);
    service.start();
    try {
      expect(rootApi.runContext.setRunContext({ ...params, value: "root" })).toBe(true);
      expect(scopedApi.runContext.setRunContext({ ...params, value: "inspection" })).toBe(false);
      expect(scopedApi.runContext.getRunContext(params)).toBeUndefined();
      scopedApi.runContext.clearRunContext(params);
      expect(rootApi.runContext.getRunContext(params)).toBe("root");
      await createHookRunner(scoped.registry).runLlmInput(
        {
          runId,
          sessionId: "session",
          provider: "openai",
          model: "model",
          prompt: "work",
          historyMessages: [],
          imagesCount: 0,
        },
        { runId, sessionKey: "agent:main:main", agentId: "main", trigger: "user" },
      );
      expect(writes).toEqual([true]);
      expect(reads).toEqual([{ admitted: true }, undefined]);
      emitAgentEvent({
        runId,
        sessionKey: "agent:main:main",
        stream: "tool",
        data: { phase: "start", name: "exec" },
      });
      await waitForPluginEventHandlers();
      expect(observations).toEqual([{ admitted: true }]);
      await disposePluginRegistryInstances(scoped.registry);
      expect(scopedApi.runContext.setRunContext({ ...params, value: "retired" })).toBe(false);
      expect(scopedApi.runContext.getRunContext(params)).toBeUndefined();
      scopedApi.runContext.clearRunContext(params);
      expect(rootApi.runContext.getRunContext(params)).toEqual({ admitted: true });
    } finally {
      service.stop();
      await disposePluginRegistryInstances(scoped.registry);
    }
  });

  it("does not register scheduler jobs globally during non-activating registry loads", () => {
    const registry = inspectionRegistry();
    const config = {};
    const job = { id: "snapshot-job", sessionKey: "agent:main:main", kind: "monitor" };
    let handle: ReturnType<OpenClawPluginApi["registerSessionSchedulerJob"]> | undefined;
    registerInto({ registry, config }, { id: "snapshot-fixture" }, (api) => {
      handle = api.registerSessionSchedulerJob(job);
    });

    expect(handle).toEqual({ ...job, pluginId: "snapshot-fixture" });
    const schedulerJobs = registry.registry.sessionSchedulerJobs;
    expect(schedulerJobs).toHaveLength(1);
    const schedulerJob = schedulerJobs[0];
    expect(schedulerJob?.pluginId).toBe("snapshot-fixture");
    expect(schedulerJob?.job).toMatchObject(job);
    expect(listPluginSessionSchedulerJobs("snapshot-fixture")).toStrictEqual([]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
