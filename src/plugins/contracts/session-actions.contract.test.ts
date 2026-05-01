import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPROVALS_SCOPE, READ_SCOPE, WRITE_SCOPE } from "../../gateway/operator-scopes.js";
import { handleGatewayRequest } from "../../gateway/server-methods.js";
import { pluginHostHookHandlers } from "../../gateway/server-methods/plugin-host-hooks.js";
import type { GatewayClient, RespondFn } from "../../gateway/server-methods/types.js";
import { onAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { createPluginRegistry } from "../registry.js";
import { setActivePluginRegistry } from "../runtime.js";
import { createPluginRecord } from "../status.test-helpers.js";
import type { OpenClawPluginApi } from "../types.js";

async function callPluginSessionActionForTest(params: {
  body: Record<string, unknown>;
  scopes?: string[];
}): Promise<{ ok: boolean; payload?: unknown; error?: unknown }> {
  let response: { ok: boolean; payload?: unknown; error?: unknown } | undefined;
  const respond: RespondFn = (ok, payload, error) => {
    response = { ok, payload, error };
  };
  await pluginHostHookHandlers["plugins.sessionAction"]({
    req: { id: "test", type: "req", method: "plugins.sessionAction", params: params.body },
    params: params.body,
    client: {
      connId: "test-client",
      connect: { scopes: params.scopes ?? [WRITE_SCOPE] },
    } as GatewayClient,
    isWebchatConnect: () => false,
    respond,
    context: {} as never,
  });
  return response ?? { ok: false, error: new Error("handler did not respond") };
}

async function callPluginSessionActionThroughGatewayForTest(params: {
  body: Record<string, unknown>;
  scopes?: string[];
}): Promise<{ ok: boolean; payload?: unknown; error?: unknown }> {
  let response: { ok: boolean; payload?: unknown; error?: unknown } | undefined;
  const respond: RespondFn = (ok, payload, error) => {
    response = { ok, payload, error };
  };
  await handleGatewayRequest({
    req: { id: "test", type: "req", method: "plugins.sessionAction", params: params.body },
    respond,
    client: {
      connId: "test-client",
      connect: {
        role: "operator",
        scopes: params.scopes ?? [],
      },
    } as GatewayClient,
    isWebchatConnect: () => false,
    context: {
      logGateway: {
        warn() {},
      },
    } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
  });
  return response ?? { ok: false, error: new Error("handler did not respond") };
}

describe("plugin session actions", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    resetAgentEventsForTest();
  });

  it("initializes and registers typed session actions", () => {
    expect(createEmptyPluginRegistry().sessionActions).toEqual([]);

    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "session-action-fixture",
        name: "Session Action Fixture",
      }),
      register(api) {
        api.registerSessionAction({
          id: "approve",
          description: "Approve the current workflow",
          requiredScopes: [APPROVALS_SCOPE],
          handler: () => ({ ok: true, data: { accepted: true } }),
        });
      },
    });

    expect(registry.registry.sessionActions).toHaveLength(1);
    expect(registry.registry.sessionActions?.[0]).toMatchObject({
      pluginId: "session-action-fixture",
      pluginName: "Session Action Fixture",
      action: {
        id: "approve",
        description: "Approve the current workflow",
        requiredScopes: [APPROVALS_SCOPE],
      },
    });
  });

  it("rejects invalid or duplicate session action registrations", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "invalid-session-actions",
        name: "Invalid Session Actions",
      }),
      register(api) {
        api.registerSessionAction({
          id: "dup",
          handler: () => ({ ok: true }),
        });
        api.registerSessionAction({
          id: "dup",
          handler: () => ({ ok: true }),
        });
        api.registerSessionAction({
          id: "bad-scope",
          requiredScopes: ["not-a-scope"] as never,
          handler: () => ({ ok: true }),
        });
        api.registerSessionAction({
          id: "bad-schema-shape",
          schema: "not-an-object" as never,
          handler: () => ({ ok: true }),
        });
        api.registerSessionAction({
          id: "bad-schema-compile",
          schema: { type: "not-a-json-schema-type" } as never,
          handler: () => ({ ok: true }),
        });
        api.registerSessionAction({
          id: "",
          handler: () => ({ ok: true }),
        });
      },
    });

    expect(registry.registry.sessionActions?.map((entry) => entry.action.id)).toEqual(["dup"]);
    expect(registry.registry.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: "invalid-session-actions",
          message: "session action already registered: dup",
        }),
        expect.objectContaining({
          pluginId: "invalid-session-actions",
          message: "session action requiredScopes contains unknown operator scope: not-a-scope",
        }),
        expect.objectContaining({
          pluginId: "invalid-session-actions",
          message: "session action schema must be a JSON schema object: bad-schema-shape",
        }),
        expect.objectContaining({
          pluginId: "invalid-session-actions",
          message: expect.stringContaining(
            "session action schema is not valid JSON Schema: bad-schema-compile",
          ),
        }),
        expect.objectContaining({
          pluginId: "invalid-session-actions",
          message: "session action registration requires id, handler, and valid optional fields",
        }),
      ]),
    );
  });

  it("validates payload schemas and typed action results", async () => {
    const handlerCalls: unknown[] = [];
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "schema-action-fixture",
        name: "Schema Action Fixture",
      }),
      register(api) {
        api.registerSessionAction({
          id: "approve",
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["version"],
            properties: {
              version: { type: "string" },
            },
          },
          handler: ({ payload, sessionKey, client }) => {
            handlerCalls.push({ payload, sessionKey, scopes: client?.scopes ?? [] });
            return {
              data: { accepted: true, ...(sessionKey ? { sessionKey } : {}) },
              continueAgent: true,
              reply: { text: "approved" },
            };
          },
        });
        api.registerSessionAction({
          id: "typed-error",
          handler: () => ({
            ok: false,
            error: "needs operator input",
            code: "needs_input",
            details: { field: "version" },
          }),
        });
      },
    });
    setActivePluginRegistry(registry.registry);

    const rejected = await callPluginSessionActionForTest({
      body: {
        pluginId: "schema-action-fixture",
        actionId: "approve",
        payload: { version: 1 },
      },
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(String((rejected.error as { message?: unknown } | undefined)?.message)).toContain(
      "plugin session action payload does not match schema",
    );
    expect(handlerCalls).toEqual([]);

    await expect(
      callPluginSessionActionForTest({
        body: {
          pluginId: "schema-action-fixture",
          actionId: "approve",
          sessionKey: "agent:main:main",
          payload: { version: "2026.05.01" },
        },
      }),
    ).resolves.toEqual({
      ok: true,
      payload: {
        ok: true,
        result: { accepted: true, sessionKey: "agent:main:main" },
        continueAgent: true,
        reply: { text: "approved" },
      },
      error: undefined,
    });
    expect(handlerCalls).toEqual([
      {
        payload: { version: "2026.05.01" },
        sessionKey: "agent:main:main",
        scopes: [WRITE_SCOPE],
      },
    ]);

    await expect(
      callPluginSessionActionForTest({
        body: {
          pluginId: "schema-action-fixture",
          actionId: "typed-error",
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      payload: {
        ok: false,
        error: "needs operator input",
        code: "needs_input",
        details: {
          field: "version",
        },
      },
    });
  });

  it("validates plugin session action results before returning gateway payloads", async () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "session-action-validation-fixture",
        name: "Session Action Validation Fixture",
      }),
      register(api) {
        api.registerSessionAction({
          id: "bad-data",
          handler: () => ({ data: 1n as never }),
        });
        api.registerSessionAction({
          id: "bad-reply",
          handler: () => ({ reply: { text: "ok", extra: () => undefined } as never }),
        });
        api.registerSessionAction({
          id: "primitive-result",
          handler: () => "not-an-object" as never,
        });
        api.registerSessionAction({
          id: "typed-error",
          handler: () => ({
            ok: false,
            error: "needs operator input",
            code: "needs_input",
            details: { field: "version" },
          }),
        });
        api.registerSessionAction({
          id: "bad-ok",
          handler: () =>
            ({
              ok: "false",
              error: "must not masquerade as success",
            }) as never,
        });
        api.registerSessionAction({
          id: "error-shaped-success",
          handler: () =>
            ({
              error: "must declare ok false",
            }) as never,
        });
        api.registerSessionAction({
          id: "bad-error-details",
          handler: () => ({
            ok: false,
            error: "bad details",
            details: { value: 1n } as never,
          }),
        });
        api.registerSessionAction({
          id: "bad-continue-agent",
          handler: () => ({ continueAgent: "yes" as never }),
        });
        api.registerSessionAction({
          id: "throws-secret",
          handler: () => {
            throw new Error("fixture action failed");
          },
        });
      },
    });
    setActivePluginRegistry(registry.registry);

    await expect(
      callPluginSessionActionForTest({
        body: {
          pluginId: "session-action-validation-fixture",
          actionId: "bad-data",
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "plugin session action result must be JSON-compatible",
      },
    });
    await expect(
      callPluginSessionActionForTest({
        body: {
          pluginId: "session-action-validation-fixture",
          actionId: "bad-reply",
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "plugin session action reply must be JSON-compatible",
      },
    });
    await expect(
      callPluginSessionActionForTest({
        body: {
          pluginId: "session-action-validation-fixture",
          actionId: "primitive-result",
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "plugin session action result must be an object",
      },
    });
    await expect(
      callPluginSessionActionForTest({
        body: {
          pluginId: "session-action-validation-fixture",
          actionId: "typed-error",
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      payload: {
        ok: false,
        error: "needs operator input",
        details: {
          field: "version",
        },
      },
    });
    await expect(
      callPluginSessionActionForTest({
        body: {
          pluginId: "session-action-validation-fixture",
          actionId: "bad-ok",
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "plugin session action ok must be a boolean",
      },
    });
    await expect(
      callPluginSessionActionForTest({
        body: {
          pluginId: "session-action-validation-fixture",
          actionId: "error-shaped-success",
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "plugin session action failure fields require ok=false",
      },
    });
    await expect(
      callPluginSessionActionForTest({
        body: {
          pluginId: "session-action-validation-fixture",
          actionId: "bad-error-details",
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "plugin session action error details must be JSON-compatible",
      },
    });
    await expect(
      callPluginSessionActionForTest({
        body: {
          pluginId: "session-action-validation-fixture",
          actionId: "bad-continue-agent",
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "plugin session action continueAgent must be a boolean",
      },
    });
    await expect(
      callPluginSessionActionForTest({
        body: {
          pluginId: "session-action-validation-fixture",
          actionId: "throws-secret",
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "plugin session action failed",
      },
    });
  });

  it("authorizes session actions through the gateway by action-declared scopes", async () => {
    const handlerCalls: unknown[] = [];
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "approval-action-fixture",
        name: "Approval Action Fixture",
      }),
      register(api) {
        api.registerSessionAction({
          id: "approve",
          requiredScopes: [APPROVALS_SCOPE],
          handler: ({ client, sessionKey }) => {
            handlerCalls.push({ scopes: client?.scopes ?? [], sessionKey });
            return {
              data: { approved: true, ...(sessionKey ? { sessionKey } : {}) },
              continueAgent: true,
            };
          },
        });
        api.registerSessionAction({
          id: "view",
          requiredScopes: [READ_SCOPE],
          handler: ({ client }) => {
            handlerCalls.push({ scopes: client?.scopes ?? [], action: "view" });
            return { data: { visible: true }, continueAgent: false };
          },
        });
      },
    });
    setActivePluginRegistry(registry.registry);

    await expect(
      callPluginSessionActionThroughGatewayForTest({
        body: {
          pluginId: "approval-action-fixture",
          actionId: "approve",
        },
        scopes: [APPROVALS_SCOPE],
      }),
    ).resolves.toEqual({
      ok: true,
      payload: { ok: true, result: { approved: true }, continueAgent: true },
      error: undefined,
    });

    await expect(
      callPluginSessionActionThroughGatewayForTest({
        body: {
          pluginId: "approval-action-fixture",
          actionId: "view",
        },
        scopes: [WRITE_SCOPE],
      }),
    ).resolves.toEqual({
      ok: true,
      payload: { ok: true, result: { visible: true }, continueAgent: false },
      error: undefined,
    });

    await expect(
      callPluginSessionActionThroughGatewayForTest({
        body: {
          pluginId: "approval-action-fixture",
          actionId: "approve",
        },
        scopes: [READ_SCOPE],
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: `plugin session action requires gateway scope: ${APPROVALS_SCOPE}`,
      },
    });
    expect(handlerCalls).toEqual([
      { scopes: [APPROVALS_SCOPE], sessionKey: undefined },
      { scopes: [WRITE_SCOPE], action: "view" },
    ]);

    await expect(
      callPluginSessionActionThroughGatewayForTest({
        body: {
          pluginId: "approval-action-fixture",
          actionId: "approve",
          sessionKey: " agent:main:main ",
        },
        scopes: [APPROVALS_SCOPE],
      }),
    ).resolves.toEqual({
      ok: true,
      payload: {
        ok: true,
        result: { approved: true, sessionKey: "agent:main:main" },
        continueAgent: true,
      },
      error: undefined,
    });

    await expect(
      callPluginSessionActionThroughGatewayForTest({
        body: {
          pluginId: "approval-action-fixture",
          actionId: "view",
        },
        scopes: [READ_SCOPE],
      }),
    ).resolves.toEqual({
      ok: true,
      payload: { ok: true, result: { visible: true }, continueAgent: false },
      error: undefined,
    });

    await expect(
      callPluginSessionActionThroughGatewayForTest({
        body: {
          pluginId: "   ",
          actionId: "approve",
        },
        scopes: [APPROVALS_SCOPE],
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "plugins.sessionAction pluginId and actionId must be non-empty",
      },
    });
    expect(handlerCalls).toEqual([
      { scopes: [APPROVALS_SCOPE], sessionKey: undefined },
      { scopes: [WRITE_SCOPE], action: "view" },
      { scopes: [APPROVALS_SCOPE], sessionKey: "agent:main:main" },
      { scopes: [READ_SCOPE], action: "view" },
    ]);
  });

  it("does not dispatch session actions for plugins that are not loaded", async () => {
    const handler = vi.fn(() => ({ data: { stale: true } }));
    const registry = createEmptyPluginRegistry();
    registry.sessionActions = [
      {
        pluginId: "failed-action-plugin",
        pluginName: "Failed Action Plugin",
        source: "test",
        action: {
          id: "stale",
          requiredScopes: [READ_SCOPE],
          handler,
        },
      },
    ];
    registry.plugins = [
      createPluginRecord({
        id: "failed-action-plugin",
        name: "Failed Action Plugin",
        status: "error",
      }),
    ];
    setActivePluginRegistry(registry);

    await expect(
      callPluginSessionActionThroughGatewayForTest({
        body: {
          pluginId: "failed-action-plugin",
          actionId: "stale",
        },
        scopes: [READ_SCOPE],
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "unknown plugin session action: failed-action-plugin/stale",
      },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("emits plugin-attributed agent events through the plugin API", () => {
    const observed: unknown[] = [];
    const unsubscribe = onAgentEvent((event) => observed.push(event));
    const { config, registry } = createPluginRegistryFixture();
    let bundledApi: OpenClawPluginApi | undefined;
    let workspaceApi: OpenClawPluginApi | undefined;
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "event-plugin",
        name: "Event Plugin",
        origin: "bundled",
      }),
      register(api) {
        bundledApi = api;
      },
    });
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "workspace-event-plugin",
        name: "Workspace Event Plugin",
        origin: "workspace",
      }),
      register(api) {
        workspaceApi = api;
      },
    });

    try {
      expect(
        bundledApi?.emitAgentEvent({
          runId: "run-emit",
          sessionKey: " agent:main:main ",
          stream: "approval",
          data: { state: "queued" },
        }),
      ).toEqual({ emitted: true, stream: "approval" });
      expect(
        workspaceApi?.emitAgentEvent({
          runId: "run-emit",
          stream: "lifecycle",
          data: { phase: "end" },
        }),
      ).toEqual({ emitted: false, reason: "stream lifecycle is reserved for bundled plugins" });
      expect(
        workspaceApi?.emitAgentEvent({
          runId: "run-emit",
          stream: "assistant",
          data: { text: "spoofed assistant output" },
        }),
      ).toEqual({ emitted: false, reason: "stream assistant is reserved for bundled plugins" });
      expect(
        workspaceApi?.emitAgentEvent({
          runId: "run-emit",
          stream: "other-plugin.workflow",
          data: { state: "queued" },
        }),
      ).toEqual({
        emitted: false,
        reason: "stream other-plugin.workflow must be scoped to plugin workspace-event-plugin",
      });
      expect(
        workspaceApi?.emitAgentEvent({
          runId: "run-emit",
          stream: "workspace-event-plugin.workflow",
          data: { state: "queued" },
        }),
      ).toEqual({ emitted: true, stream: "workspace-event-plugin.workflow" });
      expect(
        bundledApi?.emitAgentEvent({
          runId: "run-emit",
          stream: "approval",
          data: 1n as never,
        }),
      ).toEqual({ emitted: false, reason: "event data must be JSON-compatible" });
    } finally {
      unsubscribe();
    }

    expect(observed).toEqual([
      expect.objectContaining({
        runId: "run-emit",
        sessionKey: "agent:main:main",
        stream: "approval",
        data: {
          state: "queued",
          pluginId: "event-plugin",
          pluginName: "Event Plugin",
        },
      }),
      expect.objectContaining({
        runId: "run-emit",
        stream: "workspace-event-plugin.workflow",
        data: {
          state: "queued",
          pluginId: "workspace-event-plugin",
          pluginName: "Workspace Event Plugin",
        },
      }),
    ]);
  });

  it("blocks agent events from stale and non-activating plugin API closures", () => {
    const observed: unknown[] = [];
    const unsubscribe = onAgentEvent((event) => observed.push(event));
    const { config, registry } = createPluginRegistryFixture();
    let capturedApi: OpenClawPluginApi | undefined;
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "stale-event-plugin",
        name: "Stale Event Plugin",
        origin: "bundled",
      }),
      register(api) {
        capturedApi = api;
      },
    });
    setActivePluginRegistry(registry.registry);
    setActivePluginRegistry(createEmptyPluginRegistry());

    try {
      expect(
        capturedApi?.emitAgentEvent({
          runId: "stale-run",
          stream: "approval",
          data: { stale: true },
        }),
      ).toEqual({ emitted: false, reason: "plugin is not loaded" });

      const inactiveRegistry = createPluginRegistry({
        logger: {
          info() {},
          warn() {},
          error() {},
          debug() {},
        },
        runtime: {} as never,
        activateGlobalSideEffects: false,
      });
      let inactiveApi: OpenClawPluginApi | undefined;
      registerTestPlugin({
        registry: inactiveRegistry,
        config,
        record: createPluginRecord({
          id: "inactive-event-plugin",
          name: "Inactive Event Plugin",
          origin: "bundled",
        }),
        register(api) {
          inactiveApi = api;
        },
      });
      expect(
        inactiveApi?.emitAgentEvent({
          runId: "inactive-run",
          stream: "approval",
          data: { inactive: true },
        }),
      ).toEqual({ emitted: false, reason: "global side effects disabled" });
    } finally {
      unsubscribe();
    }

    expect(observed).toEqual([]);
  });
});
