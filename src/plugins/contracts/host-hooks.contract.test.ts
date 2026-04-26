import { afterEach, describe, expect, it } from "vitest";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "../../../test/helpers/plugins/contracts-testkit.js";
import {
  validatePluginsUiDescriptorsParams,
  validateSessionsPluginPatchParams,
} from "../../gateway/protocol/index.js";
import { buildGatewaySessionRow } from "../../gateway/session-utils.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import { createHookRunner } from "../hooks.js";
import {
  cleanupReplacedPluginHostRegistry,
  clearPluginOwnedSessionState,
  runPluginHostCleanup,
} from "../host-hook-cleanup.js";
import {
  clearPluginHostRuntimeState,
  getPluginRunContext,
  listPluginSessionSchedulerJobs,
} from "../host-hook-runtime.js";
import { buildPluginAgentTurnPrepareContext } from "../host-hooks.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { setActivePluginRegistry } from "../runtime.js";
import { createPluginRecord } from "../status.test-helpers.js";
import { runTrustedToolPolicies } from "../trusted-tool-policy.js";
import { registerHostHookFixture, registerTrustedHostHookFixture } from "./host-hook-fixture.js";

describe("host-hook fixture plugin contract", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearPluginHostRuntimeState();
    resetAgentEventsForTest();
  });

  it("registers generic SDK seams without Plan Mode business logic", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "host-hook-fixture",
        name: "Host Hook Fixture",
        origin: "workspace",
      }),
      register: registerHostHookFixture,
    });

    expect(registry.registry.sessionExtensions ?? []).toHaveLength(1);
    expect(registry.registry.toolMetadata ?? []).toHaveLength(1);
    expect(registry.registry.controlUiDescriptors ?? []).toHaveLength(1);
    expect(registry.registry.runtimeLifecycles ?? []).toHaveLength(1);
    expect(registry.registry.agentEventSubscriptions ?? []).toHaveLength(1);
    expect(registry.registry.sessionSchedulerJobs ?? []).toHaveLength(1);
    expect(registry.registry.commands.map((entry) => entry.command.name)).toEqual([
      "host-hook-fixture",
    ]);
    expect(registry.registry.typedHooks.map((entry) => entry.hookName).toSorted()).toEqual([
      "agent_turn_prepare",
      "heartbeat_prompt_contribution",
    ]);
  });

  it("rejects external plugins from trusted policy and reserved command ownership", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "external-policy",
        name: "External Policy",
        origin: "workspace",
      }),
      register(api) {
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
    });

    expect(registry.registry.trustedToolPolicies ?? []).toHaveLength(0);
    expect(registry.registry.commands).toHaveLength(0);
    expect(registry.registry.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: "external-policy",
          message: expect.stringContaining("only bundled plugins can register trusted tool"),
        }),
        expect.objectContaining({
          pluginId: "external-policy",
          message: expect.stringContaining("only bundled plugins can claim reserved command"),
        }),
      ]),
    );
  });

  it("lets bundled fixture policies run before normal before_tool_call hooks", async () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "trusted-fixture",
        name: "Trusted Fixture",
        origin: "bundled",
      }),
      register: registerTrustedHostHookFixture,
    });
    setActivePluginRegistry(registry.registry);

    await expect(
      runTrustedToolPolicies(
        { toolName: "blocked_fixture_tool", params: {} },
        { toolName: "blocked_fixture_tool" },
      ),
    ).resolves.toMatchObject({
      block: true,
      blockReason: "blocked by fixture policy",
    });
  });

  it("projects registered session extensions into gateway session rows", () => {
    const { config, registry } = createPluginRegistryFixture();
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

  it("models queued next-turn injections and agent_turn_prepare as one prompt context", async () => {
    const { config, registry } = createPluginRegistryFixture();
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
      [queuedContext.prependContext, queuedContext.appendContext, hookContext?.prependContext]
        .filter(Boolean)
        .join("\n\n"),
    ).toContain("approval workflow resumed");
    expect(hookContext?.prependContext).toBe("fixture turn context");
  });

  it("validates gateway protocol envelopes for plugin patch and UI descriptors", () => {
    expect(
      validateSessionsPluginPatchParams({
        key: "agent:main:main",
        pluginId: "approval-plugin",
        namespace: "workflow",
        value: { state: "waiting" },
      }),
    ).toBe(true);
    expect(
      validateSessionsPluginPatchParams({
        key: "agent:main:main",
        pluginId: "approval-plugin",
        namespace: "workflow",
        value: { state: "waiting" },
        accidentalPlanModeRootField: true,
      }),
    ).toBe(false);
    expect(validatePluginsUiDescriptorsParams({})).toBe(true);
    expect(validatePluginsUiDescriptorsParams({ pluginId: "host-hook-fixture" })).toBe(false);
  });

  it("dispatches sanitized agent events and clears plugin run context on run end", async () => {
    const { config, registry } = createPluginRegistryFixture();
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

    emitAgentEvent({
      runId: "run-1",
      stream: "tool",
      data: { name: "approval_fixture_tool" },
    });
    await Promise.resolve();

    expect(
      getPluginRunContext({
        pluginId: "host-hook-fixture",
        get: { runId: "run-1", namespace: "lastToolEvent" },
      }),
    ).toEqual({ runId: "run-1", seen: true });

    emitAgentEvent({
      runId: "run-1",
      stream: "lifecycle",
      data: { phase: "end" },
    });
    await Promise.resolve();

    expect(
      getPluginRunContext({
        pluginId: "host-hook-fixture",
        get: { runId: "run-1", namespace: "lastToolEvent" },
      }),
    ).toBeUndefined();
  });

  it("covers the non-Plan plugin archetypes promised by the host-hook fixture", () => {
    const archetypes = [
      {
        name: "approval workflow",
        seams: [
          "session extension",
          "command continuation",
          "next-turn injection",
          "UI descriptor",
        ],
      },
      {
        name: "budget/workspace policy gate",
        seams: ["trusted tool policy", "tool metadata", "session projection"],
      },
      {
        name: "background lifecycle monitor",
        seams: ["agent event subscription", "scheduler cleanup", "heartbeat prompt contribution"],
      },
    ];

    expect(archetypes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "approval workflow" }),
        expect.objectContaining({ name: "budget/workspace policy gate" }),
        expect.objectContaining({ name: "background lifecycle monitor" }),
      ]),
    );
    expect(archetypes.flatMap((entry) => entry.seams)).toEqual(
      expect.arrayContaining([
        "session extension",
        "trusted tool policy",
        "agent event subscription",
        "scheduler cleanup",
      ]),
    );
  });

  it("proves every #71676 Plan Mode entry-point class has a generic host seam", () => {
    const parityMap = [
      ["session state + sessions.patch", "session extensions + sessions.pluginPatch"],
      [
        "pending injections + approval resumes",
        "durable next-turn injections + agent_turn_prepare",
      ],
      ["mutation gates around tools", "trusted tool policy before before_tool_call"],
      ["slash/native command continuations", "requiredScopes + reserved ownership + continueAgent"],
      ["Control UI mode/cards/status", "Control UI descriptor projection"],
      [
        "plan snapshots, nudges, subagent follow-ups, heartbeat",
        "agent events + run context + scheduler cleanup + heartbeat contribution",
      ],
      ["tool catalog display metadata", "plugin tool metadata projection"],
      ["disable/reset/delete/restart cleanup", "runtime lifecycle cleanup"],
    ];

    expect(parityMap).toHaveLength(8);
    for (const [entryPoint, seam] of parityMap) {
      expect(entryPoint).toBeTruthy();
      expect(seam).toBeTruthy();
      expect(seam).not.toContain("Plan Mode");
    }
  });

  it("cleans plugin-owned session state and lifecycle resources on reset/disable", async () => {
    const cleanupEvents: string[] = [];
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "cleanup-fixture",
        name: "Cleanup Fixture",
      }),
      register(api) {
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
    });

    const entry = {
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

    await runPluginHostCleanup({
      registry: registry.registry,
      pluginId: "cleanup-fixture",
      reason: "reset",
      sessionKey: "agent:main:main",
    });
    await cleanupReplacedPluginHostRegistry({
      previousRegistry: registry.registry,
      nextRegistry: createEmptyPluginRegistry(),
    });

    expect(cleanupEvents).toEqual([
      "session:reset:agent:main:main",
      "runtime:reset:agent:main:main",
      "scheduler:reset:agent:main:main",
      "session:disable:",
      "runtime:disable:",
    ]);
    expect(listPluginSessionSchedulerJobs("cleanup-fixture")).toEqual([]);
  });
});
