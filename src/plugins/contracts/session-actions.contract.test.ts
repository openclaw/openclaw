// Session action contract tests cover plugin session action metadata and execution contracts.

import { expectDefined } from "@openclaw/normalization-core";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  ADMIN_SCOPE,
  APPROVALS_SCOPE,
  PAIRING_SCOPE,
  QUESTIONS_SCOPE,
  READ_SCOPE,
  TALK_SCOPE,
  TALK_SECRETS_SCOPE,
  WRITE_SCOPE,
  type OperatorScope,
} from "../../gateway/operator-scopes.js";
import { handleGatewayRequest } from "../../gateway/server-methods.js";
import { pluginHostHookHandlers } from "../../gateway/server-methods/plugin-host-hooks.js";
import type { GatewayClient, RespondFn } from "../../gateway/server-methods/types.js";
import {
  withPreparedSessionRows,
  type SessionRowReadView,
} from "../../gateway/session-row-prepared-read.js";
import { bindSessionRowProjection } from "../../gateway/session-row-projection-access.js";
import type { SessionRowProjection } from "../../gateway/session-row-projection.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { PluginSessionActionContext } from "../host-hooks.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { setActivePluginRegistry } from "../runtime.js";
import { createPluginRecord } from "../status.test-fixtures.js";
import type { OpenClawPluginApi } from "../types.js";

const MAIN_SESSION_KEY = "agent:main:main";

type HookResponse = { ok: boolean; payload?: unknown; error?: unknown };

function createSessionActionContextForTest(
  options: {
    projectedContextTokens?: number;
    modelCatalog?: SessionRowProjection["state"]["modelCatalog"];
    beforeRead?: () => Promise<void>;
  } = {},
) {
  const cfg: OpenClawConfig = {
    agents: { defaults: { model: { primary: "openai/pr-bridge-test" } } },
    models: {
      providers: {
        openai: {
          baseUrl: "https://example.invalid/v1",
          models: [
            {
              id: "pr-bridge-test",
              name: "PR Bridge Test",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextTokens: 64_000,
              maxTokens: 4_096,
            },
          ],
        },
      },
    },
  };
  const read = {
    state: { cfg, policyConfig: cfg, rowContext: {} },
    describe: () =>
      options.projectedContextTokens === undefined
        ? undefined
        : { materialized: { row: { contextTokens: options.projectedContextTokens } } },
  } as unknown as SessionRowReadView;
  const withPreparedExactRows: SessionRowProjection["withPreparedExactRows"] = async (
    queries,
    consume,
  ) => {
    await options.beforeRead?.();
    return withPreparedSessionRows(
      { ...read, isCurrent: () => true, getPolicyConfig: () => cfg },
      () => true,
      queries,
      consume,
    );
  };
  const projection = {
    state: { modelCatalog: options.modelCatalog ?? [] },
    withPreparedExactRows,
    sharingTargetState: () => ({ status: "missing" }),
  } as unknown as SessionRowProjection;
  return bindSessionRowProjection(
    {
      getRuntimeConfig: () => cfg,
      logGateway: { warn() {} },
    },
    () => projection,
  );
}

function sessionActionBody(
  pluginId: string,
  actionId: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    pluginId,
    actionId,
    ...extra,
  };
}

async function callPluginSessionActionForTest(params: {
  body: Record<string, unknown>;
  scopes?: string[];
  context?: ReturnType<typeof createSessionActionContextForTest>;
}): Promise<HookResponse> {
  let response: HookResponse | undefined;
  const respond: RespondFn = (ok, payload, error) => {
    response = { ok, payload, error };
  };
  await expectDefined(
    pluginHostHookHandlers["plugins.sessionAction"],
    'pluginHostHookHandlers["plugins.sessionAction"] test invariant',
  )({
    req: { id: "test", type: "req", method: "plugins.sessionAction", params: params.body },
    params: params.body,
    client: {
      connId: "test-client",
      connect: { scopes: params.scopes ?? [WRITE_SCOPE] },
    } as GatewayClient,
    isWebchatConnect: () => false,
    respond,
    context: (params.context ?? createSessionActionContextForTest()) as never,
  });
  return response ?? { ok: false, error: new Error("handler did not respond") };
}

async function callRegisteredSessionActionForTest(params: {
  pluginId: string;
  actionId: string;
  extra?: Record<string, unknown>;
  scopes?: string[];
}): Promise<HookResponse> {
  return callPluginSessionActionForTest({
    body: sessionActionBody(params.pluginId, params.actionId, params.extra),
    ...(params.scopes ? { scopes: params.scopes } : {}),
  });
}

async function callPluginSessionActionThroughGatewayForTest(params: {
  body: Record<string, unknown>;
  scopes?: string[];
}): Promise<HookResponse> {
  let response: HookResponse | undefined;
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
    context: createSessionActionContextForTest() as unknown as Parameters<
      typeof handleGatewayRequest
    >[0]["context"],
  });
  return response ?? { ok: false, error: new Error("handler did not respond") };
}

async function callRegisteredSessionActionThroughGatewayForTest(params: {
  pluginId: string;
  actionId: string;
  extra?: Record<string, unknown>;
  scopes?: string[];
}): Promise<HookResponse> {
  return callPluginSessionActionThroughGatewayForTest({
    body: sessionActionBody(params.pluginId, params.actionId, params.extra),
    ...(params.scopes ? { scopes: params.scopes } : {}),
  });
}

function requireHookError(response: HookResponse): { code?: unknown; message?: unknown } {
  expect(response.ok).toBe(false);
  const error = response.error as { code?: unknown; message?: unknown } | undefined;
  if (!error) {
    throw new Error("expected hook error");
  }
  return error;
}

function registerActionFixture(params: {
  id: string;
  name?: string;
  register: (api: OpenClawPluginApi) => void;
}) {
  const { config, registry } = createPluginRegistryFixture();
  registerTestPlugin({
    registry,
    config,
    record: createPluginRecord({
      id: params.id,
      name: params.name ?? params.id,
    }),
    register: params.register,
  });
  return { config, registry };
}

describe("plugin session actions", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("initializes and registers typed session actions", () => {
    expect(createEmptyPluginRegistry().sessionActions).toEqual([]);

    const { registry } = registerActionFixture({
      id: "session-action-fixture",
      name: "Session Action Fixture",
      register(api) {
        api.registerSessionAction({
          id: "approve",
          description: "Approve the current workflow",
          requiredScopes: [APPROVALS_SCOPE],
          handler: () => ({ ok: true, result: { accepted: true } }),
        });
      },
    });

    expect(registry.registry.sessionActions).toHaveLength(1);
    const actionEntry = registry.registry.sessionActions[0];
    expect(actionEntry?.pluginId).toBe("session-action-fixture");
    expect(actionEntry?.pluginName).toBe("Session Action Fixture");
    expect(actionEntry?.action.id).toBe("approve");
    expect(actionEntry?.action.description).toBe("Approve the current workflow");
    expect(actionEntry?.action.requiredScopes).toEqual([APPROVALS_SCOPE]);
  });

  it("rejects invalid or duplicate session action registrations", () => {
    const { registry } = registerActionFixture({
      id: "invalid-session-actions",
      name: "Invalid Session Actions",
      register(api) {
        for (const action of [
          { id: "dup" },
          { id: "dup" },
          { id: "bad-scope", requiredScopes: ["not-a-scope"] as never },
          { id: "bad-schema-shape", schema: "not-an-object" as never },
          { id: "bad-schema-compile", schema: { type: "not-a-json-schema-type" } as never },
          {
            id: "bad-schema-keyword",
            schema: {
              type: "object",
              properties: { id: { type: "string" } },
              required: "id",
            } as never,
          },
          {
            id: "bad-schema-ref",
            schema: { $ref: "#/$defs/Missing" } as never,
          },
          { id: "" },
        ]) {
          api.registerSessionAction({
            ...action,
            handler: () => ({ ok: true }),
          });
        }
      },
    });

    expect(registry.registry.sessionActions.map((entry) => entry.action.id)).toEqual(["dup"]);
    const diagnosticMessages = registry.registry.diagnostics?.map((diagnostic) => {
      expect(diagnostic.pluginId).toBe("invalid-session-actions");
      return diagnostic.message;
    });
    expect(diagnosticMessages).toHaveLength(7);
    expect(diagnosticMessages).toContain("session action already registered: dup");
    expect(diagnosticMessages).toContain(
      "session action requiredScopes contains unknown operator scope: not-a-scope",
    );
    expect(diagnosticMessages).toContain(
      "session action schema must be a JSON schema object or boolean: bad-schema-shape",
    );
    expect(
      diagnosticMessages?.some((message) =>
        message.includes("session action schema is not valid JSON Schema: bad-schema-compile"),
      ),
    ).toBe(true);
    expect(
      diagnosticMessages?.some((message) =>
        message.includes("session action schema is not valid JSON Schema: bad-schema-keyword"),
      ),
    ).toBe(true);
    expect(
      diagnosticMessages?.some((message) =>
        message.includes("session action schema is not valid JSON Schema: bad-schema-ref"),
      ),
    ).toBe(true);
    expect(diagnosticMessages).toContain(
      "session action registration requires id, handler, and valid optional fields",
    );
  });

  it("validates payload schemas and typed action results", async () => {
    const callSchemaAction = (
      actionId: string,
      extra?: Record<string, unknown>,
    ): Promise<{ ok: boolean; payload?: unknown; error?: unknown }> =>
      callRegisteredSessionActionForTest({
        pluginId: "schema-action-fixture",
        actionId,
        ...(extra ? { extra } : {}),
      });
    const handlerCalls: unknown[] = [];
    const { registry } = registerActionFixture({
      id: "schema-action-fixture",
      name: "Schema Action Fixture",
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
          handler: ({ payload, sessionKey, agentId, contextTokens, client }) => {
            handlerCalls.push({
              payload,
              sessionKey,
              agentId,
              contextTokens,
              scopes: client?.scopes ?? [],
            });
            return {
              result: { accepted: true, ...(sessionKey ? { sessionKey } : {}) },
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
        api.registerSessionAction({
          id: "allow-any",
          schema: true,
          handler: ({ payload }) => ({ result: { payload: payload ?? null } }),
        });
        api.registerSessionAction({
          id: "deny-all",
          schema: false,
          handler: () => ({ result: { unreachable: true } }),
        });
      },
    });
    setActivePluginRegistry(registry.registry);

    const rejected = await callPluginSessionActionForTest({
      body: sessionActionBody("schema-action-fixture", "approve", { payload: { version: 1 } }),
    });
    const rejectedError = requireHookError(rejected);
    expect(rejectedError.code).toBe("INVALID_REQUEST");
    expect(String(rejectedError.message)).toContain(
      "plugin session action payload does not match schema",
    );
    expect(handlerCalls).toEqual([]);

    await expect(
      callSchemaAction("approve", {
        sessionKey: MAIN_SESSION_KEY,
        payload: { version: "2026.05.01" },
      }),
    ).resolves.toEqual({
      ok: true,
      payload: {
        ok: true,
        result: { accepted: true, sessionKey: MAIN_SESSION_KEY },
        continueAgent: true,
        reply: { text: "approved" },
      },
      error: undefined,
    });
    expect(handlerCalls).toEqual([
      {
        payload: { version: "2026.05.01" },
        sessionKey: MAIN_SESSION_KEY,
        agentId: "main",
        contextTokens: 64_000,
        scopes: [WRITE_SCOPE],
      },
    ]);

    const callerSelectedLimit = await callSchemaAction("approve", {
      sessionKey: MAIN_SESSION_KEY,
      contextTokens: 1,
      payload: { version: "2026.05.01" },
    });
    expect(requireHookError(callerSelectedLimit).code).toBe("INVALID_REQUEST");
    expect(handlerCalls).toHaveLength(1);

    await expect(callSchemaAction("typed-error")).resolves.toEqual({
      ok: true,
      payload: {
        ok: false,
        error: "needs operator input",
        code: "needs_input",
        details: {
          field: "version",
        },
      },
      error: undefined,
    });

    await expect(
      callSchemaAction("allow-any", { payload: { any: ["json", true] } }),
    ).resolves.toEqual({
      ok: true,
      payload: {
        ok: true,
        result: { payload: { any: ["json", true] } },
      },
      error: undefined,
    });

    const denyAll = await callSchemaAction("deny-all", { payload: { rejected: true } });
    expect(requireHookError(denyAll).code).toBe("INVALID_REQUEST");
  });

  it("uses prepared session context limits instead of model defaults", async () => {
    const handler = vi.fn(async ({ contextTokens }: PluginSessionActionContext) => ({
      result: { contextTokens: contextTokens ?? null },
    }));
    const { registry } = registerActionFixture({
      id: "prepared-context-fixture",
      register(api) {
        api.registerSessionAction({ id: "inspect", handler });
      },
    });
    setActivePluginRegistry(registry.registry);

    await expect(
      callPluginSessionActionForTest({
        body: sessionActionBody("prepared-context-fixture", "inspect", {
          sessionKey: MAIN_SESSION_KEY,
        }),
        context: createSessionActionContextForTest({ projectedContextTokens: 32_000 }),
      }),
    ).resolves.toEqual({
      ok: true,
      payload: { ok: true, result: { contextTokens: 32_000 } },
      error: undefined,
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("uses the selected agent's prepared catalog when the session row is missing", async () => {
    const handler = vi.fn(({ contextTokens }: PluginSessionActionContext) => ({
      result: { contextTokens: contextTokens ?? null },
    }));
    const { registry } = registerActionFixture({
      id: "prepared-catalog-fixture",
      register(api) {
        api.registerSessionAction({ id: "inspect", handler });
      },
    });
    setActivePluginRegistry(registry.registry);
    const catalogEntry = {
      id: "pr-bridge-test",
      name: "PR Bridge Test",
      provider: "openai",
      contextWindow: 24_000,
    };

    await expect(
      callPluginSessionActionForTest({
        body: sessionActionBody("prepared-catalog-fixture", "inspect", {
          sessionKey: MAIN_SESSION_KEY,
        }),
        context: createSessionActionContextForTest({
          modelCatalog: new Map([
            ["other", { entries: [{ ...catalogEntry, contextWindow: 8_000 }] }],
            ["main", { entries: [catalogEntry] }],
          ]),
        }),
      }),
    ).resolves.toEqual({
      ok: true,
      payload: { ok: true, result: { contextTokens: 24_000 } },
      error: undefined,
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rechecks required action scopes after session readiness", async () => {
    const handler = vi.fn(() => ({ result: { accepted: true } }));
    const { registry } = registerActionFixture({
      id: "prepared-scope-fixture",
      register(api) {
        api.registerSessionAction({ id: "approve", requiredScopes: [WRITE_SCOPE], handler });
      },
    });
    setActivePluginRegistry(registry.registry);
    const entered = createDeferredCore();
    const ready = createDeferredCore();
    const pending = callPluginSessionActionForTest({
      body: sessionActionBody("prepared-scope-fixture", "approve", {
        sessionKey: MAIN_SESSION_KEY,
      }),
      context: createSessionActionContextForTest({
        beforeRead: () => {
          entered.resolve();
          return ready.promise;
        },
      }),
    });
    await entered.promise;
    expect(handler).not.toHaveBeenCalled();
    const registration = expectDefined(
      registry.registry.sessionActions[0],
      "prepared scope action registration",
    );
    registration.action.requiredScopes = [APPROVALS_SCOPE];
    ready.resolve();
    expect(requireHookError(await pending)).toMatchObject({
      code: "FORBIDDEN",
      message: `missing scope: ${APPROVALS_SCOPE}`,
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("validates plugin session action results before returning gateway payloads", async () => {
    const callValidationAction = (
      actionId: string,
    ): Promise<{ ok: boolean; payload?: unknown; error?: unknown }> =>
      callRegisteredSessionActionForTest({
        pluginId: "session-action-validation-fixture",
        actionId,
      });
    const { registry } = registerActionFixture({
      id: "session-action-validation-fixture",
      name: "Session Action Validation Fixture",
      register(api) {
        const handlers = {
          "bad-result": () => ({ result: 1n as never }),
          "bad-reply": () => ({ reply: { text: "ok", extra: () => undefined } as never }),
          "primitive-result": () => "not-an-object" as never,
          "typed-error": () => ({
            ok: false,
            error: "needs operator input",
            code: "needs_input",
            details: { field: "version" },
          }),
          "bad-ok": () =>
            ({
              ok: "false",
              error: "must not masquerade as success",
            }) as never,
          "error-shaped-success": () =>
            ({
              error: "must declare ok false",
            }) as never,
          "bad-error-details": () => ({
            ok: false,
            error: "bad details",
            details: { value: 1n } as never,
          }),
          "bad-continue-agent": () => ({ continueAgent: "yes" as never }),
          "mixed-branch-fields": () =>
            ({
              ok: false,
              error: "stop",
              continueAgent: true,
              result: { leaked: true },
            }) as never,
          "unknown-success-field": () =>
            ({
              result: { accepted: true },
              extra: "unexpected",
            }) as never,
          "throws-secret": () => {
            throw new Error("fixture action failed");
          },
        };
        for (const [id, handler] of Object.entries(handlers)) {
          api.registerSessionAction({ id, handler: handler as never });
        }
      },
    });
    setActivePluginRegistry(registry.registry);

    const expectValidationError = async (
      actionId: string,
      message: { exact: string } | { includes: string },
    ) => {
      const response = await callValidationAction(actionId);
      const error = requireHookError(response);
      expect(error.code).toBe("INVALID_REQUEST");
      if ("exact" in message) {
        expect(error.message).toBe(message.exact);
      } else {
        expect(String(error.message)).toContain(message.includes);
      }
    };

    await expectValidationError("bad-result", {
      exact: "plugin session action result must be JSON-compatible",
    });
    await expectValidationError("bad-reply", {
      exact: "plugin session action reply must be JSON-compatible",
    });
    const primitiveResult = await callValidationAction("primitive-result");
    const primitiveResultError = requireHookError(primitiveResult);
    expect(primitiveResultError.code).toBe("INVALID_REQUEST");
    expect(primitiveResultError.message).toBe("plugin session action result must be an object");
    await expect(callValidationAction("typed-error")).resolves.toEqual({
      ok: true,
      payload: {
        ok: false,
        error: "needs operator input",
        code: "needs_input",
        details: {
          field: "version",
        },
      },
      error: undefined,
    });
    await expectValidationError("bad-ok", { includes: "/ok: must be boolean" });
    await expectValidationError("error-shaped-success", {
      includes: "unexpected property 'error'",
    });
    await expectValidationError("bad-error-details", {
      exact: "plugin session action details must be JSON-compatible",
    });
    await expectValidationError("bad-continue-agent", {
      includes: "/continueAgent: must be boolean",
    });
    await expectValidationError("mixed-branch-fields", {
      includes: "unexpected property 'continueAgent'",
    });
    await expectValidationError("unknown-success-field", {
      includes: "unexpected property 'extra'",
    });
    const throwsSecret = await callValidationAction("throws-secret");
    const throwsSecretError = requireHookError(throwsSecret);
    expect(throwsSecretError.code).toBe("UNAVAILABLE");
    expect(throwsSecretError.message).toBe("plugin session action failed");
  });

  describe("authorizes session actions through the gateway by action-declared scopes", () => {
    const pluginId = "scope-action-fixture";
    const actionScopes = {
      approve: [APPROVALS_SCOPE],
      view: [READ_SCOPE],
      talk: [TALK_SCOPE],
      "talk-approve": [TALK_SCOPE, APPROVALS_SCOPE],
      "talk-secrets": [TALK_SECRETS_SCOPE],
      admin: [ADMIN_SCOPE],
      pairing: [PAIRING_SCOPE],
      questions: [QUESTIONS_SCOPE],
      "default-write": undefined,
    } satisfies Record<string, OperatorScope[] | undefined>;
    const handler = vi.fn(({ sessionKey }: PluginSessionActionContext) => ({
      result: { accepted: true, ...(sessionKey ? { sessionKey } : {}) },
      continueAgent: true,
    }));

    beforeEach(() => {
      handler.mockClear();
      const { registry } = registerActionFixture({
        id: pluginId,
        register(api) {
          for (const [id, requiredScopes] of Object.entries(actionScopes)) {
            api.registerSessionAction({ id, requiredScopes, handler });
          }
        },
      });
      setActivePluginRegistry(registry.registry);
    });

    it.each<
      [
        name: string,
        actionId: keyof typeof actionScopes,
        scopes: OperatorScope[],
        missingScope?: OperatorScope,
      ]
    >([
      ["approvals admits a custom approval action", "approve", [APPROVALS_SCOPE]],
      ["read cannot approve", "approve", [READ_SCOPE], APPROVALS_SCOPE],
      ["write cannot approve", "approve", [WRITE_SCOPE], APPROVALS_SCOPE],
      ["read admits a read action", "view", [READ_SCOPE]],
      ["write satisfies read", "view", [WRITE_SCOPE]],
      ["talk admits a talk action", "talk", [TALK_SCOPE]],
      ["write satisfies talk", "talk", [WRITE_SCOPE]],
      ["admin admits a talk action", "talk", [ADMIN_SCOPE]],
      ["read cannot talk", "talk", [READ_SCOPE], TALK_SCOPE],
      ["no scopes cannot talk", "talk", [], TALK_SCOPE],
      [
        "write reports missing approvals after satisfying talk",
        "talk-approve",
        [WRITE_SCOPE],
        APPROVALS_SCOPE,
      ],
      [
        "write and approvals satisfy talk and approvals",
        "talk-approve",
        [WRITE_SCOPE, APPROVALS_SCOPE],
      ],
      [
        "talk and approvals satisfy both requirements",
        "talk-approve",
        [TALK_SCOPE, APPROVALS_SCOPE],
      ],
      ["admin satisfies both requirements", "talk-approve", [ADMIN_SCOPE]],
      ["write cannot read talk secrets", "talk-secrets", [WRITE_SCOPE], TALK_SECRETS_SCOPE],
      ["write cannot administer", "admin", [WRITE_SCOPE], ADMIN_SCOPE],
      ["write cannot pair", "pairing", [WRITE_SCOPE], PAIRING_SCOPE],
      ["write cannot answer questions", "questions", [WRITE_SCOPE], QUESTIONS_SCOPE],
      ["write admits an action with default scopes", "default-write", [WRITE_SCOPE]],
      ["talk cannot perform a default-write action", "default-write", [TALK_SCOPE], WRITE_SCOPE],
      ["read cannot perform a default-write action", "default-write", [READ_SCOPE], WRITE_SCOPE],
      ["no scopes cannot perform a default-write action", "default-write", [], WRITE_SCOPE],
      ["admin admits an action with default scopes", "default-write", [ADMIN_SCOPE]],
    ])("%s", async (_name, actionId, scopes, missingScope) => {
      const response = await callRegisteredSessionActionThroughGatewayForTest({
        pluginId,
        actionId,
        scopes,
      });
      const expectedResponse: HookResponse = missingScope
        ? {
            ok: false,
            payload: undefined,
            error: {
              code: "FORBIDDEN",
              message: `missing scope: ${missingScope}`,
              details: {
                code: "MISSING_SCOPE",
                missingScope,
                requiredScopes: actionScopes[actionId] ?? [WRITE_SCOPE],
              },
            },
          }
        : {
            ok: true,
            payload: { ok: true, result: { accepted: true }, continueAgent: true },
            error: undefined,
          };
      expect({ response, handlerCalls: handler.mock.calls.length }).toEqual({
        response: expectedResponse,
        handlerCalls: missingScope ? 0 : 1,
      });
      if (!missingScope) {
        expect(handler).toHaveBeenCalledWith({
          pluginId,
          actionId,
          client: { connId: "test-client", scopes },
        });
      }
    });

    it("normalizes session keys and rejects invalid params for approval-only callers", async () => {
      await expect(
        callRegisteredSessionActionThroughGatewayForTest({
          pluginId,
          actionId: "approve",
          extra: { sessionKey: ` ${MAIN_SESSION_KEY} ` },
          scopes: [APPROVALS_SCOPE],
        }),
      ).resolves.toEqual({
        ok: true,
        payload: {
          ok: true,
          result: { accepted: true, sessionKey: MAIN_SESSION_KEY },
          continueAgent: true,
        },
        error: undefined,
      });
      expect(handler).toHaveBeenCalledWith({
        pluginId,
        actionId: "approve",
        sessionKey: MAIN_SESSION_KEY,
        agentId: "main",
        contextTokens: 64_000,
        client: { connId: "test-client", scopes: [APPROVALS_SCOPE] },
      });

      const blankPluginId = await callPluginSessionActionThroughGatewayForTest({
        body: { pluginId: "   ", actionId: "approve" },
        scopes: [APPROVALS_SCOPE],
      });
      expect(requireHookError(blankPluginId)).toEqual({
        code: "INVALID_REQUEST",
        message: "plugins.sessionAction pluginId and actionId must be non-empty",
      });
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  it("passes a defensive copy of client scopes to session action handlers", async () => {
    const registry = createEmptyPluginRegistry();
    let response: { ok: boolean; payload?: unknown; error?: unknown } | undefined;
    let handlerScopes: string[] | undefined;
    const originalScopes = [READ_SCOPE];
    registry.sessionActions = [
      {
        pluginId: "scope-copy-fixture",
        pluginName: "Scope Copy Fixture",
        source: "test",
        action: {
          id: "mutate",
          requiredScopes: [READ_SCOPE],
          handler: ({ client }) => {
            handlerScopes = client?.scopes;
            client?.scopes.push(APPROVALS_SCOPE);
            return { result: { ok: true } };
          },
        },
      },
    ];
    registry.plugins = [createPluginRecord({ id: "scope-copy-fixture" })];
    setActivePluginRegistry(registry);

    await expectDefined(
      pluginHostHookHandlers["plugins.sessionAction"],
      'pluginHostHookHandlers["plugins.sessionAction"] test invariant',
    )({
      req: {
        id: "scope-copy",
        type: "req",
        method: "plugins.sessionAction",
        params: { pluginId: "scope-copy-fixture", actionId: "mutate" },
      },
      params: { pluginId: "scope-copy-fixture", actionId: "mutate" },
      client: {
        connId: "scope-copy-client",
        connect: { scopes: originalScopes },
      } as GatewayClient,
      isWebchatConnect: () => false,
      respond: (ok, payload, error) => {
        response = { ok, payload, error };
      },
      context: { getRuntimeConfig: () => ({}) } as never,
    });

    expect(response).toEqual({
      ok: true,
      payload: { ok: true, result: { ok: true } },
      error: undefined,
    });
    expect(handlerScopes).toEqual([READ_SCOPE, APPROVALS_SCOPE]);
    expect(handlerScopes).not.toBe(originalScopes);
    expect(originalScopes).toEqual([READ_SCOPE]);
  });

  it("does not dispatch session actions for plugins that are not loaded", async () => {
    const handler = vi.fn(() => ({ result: { stale: true } }));
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

    const staleAction = await callPluginSessionActionThroughGatewayForTest({
      body: {
        pluginId: "failed-action-plugin",
        actionId: "stale",
      },
      scopes: [READ_SCOPE],
    });
    const staleActionError = requireHookError(staleAction);
    expect(staleActionError.code).toBe("UNAVAILABLE");
    expect(staleActionError.message).toBe(
      "unknown plugin session action: failed-action-plugin/stale",
    );
    expect(handler).not.toHaveBeenCalled();
  });
});
