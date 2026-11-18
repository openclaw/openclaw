import { expectDefined } from "@openclaw/normalization-core";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { onAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import * as profiles from "../../state/user-profile-list.js";
import type { PluginSessionActionContext, PluginSessionActionRegistration } from "../host-hooks.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { createPluginRegistry } from "../registry.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  setActivePluginRegistry,
  stageActivePluginRegistry,
} from "../runtime.js";
import { createPluginRecord } from "../status.test-fixtures.js";
import type { OpenClawPluginApi } from "../types.js";
type HookResponse = { ok: boolean; payload?: unknown; error?: unknown };

async function callPluginSessionActionForTest(
  params: {
    body: Record<string, unknown>;
    scopes?: string[];
  },
  throughGateway = false,
): Promise<HookResponse> {
  let response: HookResponse | undefined;
  const request = {
    req: { id: "test", type: "req" as const, method: "plugins.sessionAction", params: params.body },
    params: params.body,
    client: {
      connId: "test-client",
      connect: {
        role: "operator",
        scopes: params.scopes ?? (throughGateway ? [] : [WRITE_SCOPE]),
      },
    } as GatewayClient,
    isWebchatConnect: () => false,
    respond: ((ok, payload, error) => {
      response = { ok, payload, error };
    }) satisfies RespondFn,
    context: { logGateway: { warn() {} }, getRuntimeConfig: () => ({}) } as unknown as Parameters<
      typeof handleGatewayRequest
    >[0]["context"],
  };
  if (throughGateway) {
    await handleGatewayRequest(request);
  } else {
    await expectDefined(
      pluginHostHookHandlers["plugins.sessionAction"],
      "session action handler",
    )(request);
  }
  return response ?? { ok: false, error: new Error("handler did not respond") };
}

function callAction(
  pluginId: string,
  actionId: string,
  extra?: Record<string, unknown>,
  scopes?: string[],
  throughGateway = false,
) {
  return callPluginSessionActionForTest(
    { body: { pluginId, actionId, ...extra }, scopes },
    throughGateway,
  );
}

function requireHookError(response: HookResponse): { code?: unknown; message?: unknown } {
  expect(response.ok).toBe(false);
  const error = response.error as { code?: unknown; message?: unknown } | undefined;
  if (!error) {
    throw new Error("expected hook error");
  }
  return error;
}

function actionClient(scopes: string[]) {
  return {
    connId: "test-client",
    scopes,
    allowsAgent: expect.any(Function),
    isSharedGateway: expect.any(Function),
    assertCurrent: expect.any(Function),
  };
}

function expectObservedEvent(
  observed: unknown[],
  index: number,
  expected: Record<string, unknown>,
) {
  const event = expectDefined(observed[index], "expected observed event") as Record<
    string,
    unknown
  >;
  for (const [key, value] of Object.entries(expected)) {
    expect(event[key]).toEqual(value);
  }
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
    record: createPluginRecord({ id: params.id, name: params.name ?? params.id }),
    register: params.register,
  });
  return { config, registry };
}

function installAction(
  pluginId: string,
  action: PluginSessionActionRegistration,
  status: "loaded" | "error" = "loaded",
) {
  const registry = createEmptyPluginRegistry();
  registry.sessionActions = [{ pluginId, pluginName: pluginId, source: "test", action }];
  registry.plugins = [createPluginRecord({ id: pluginId, status })];
  setActivePluginRegistry(registry);
}

function captureEventApi(
  id: string,
  name: string,
  fixture: ReturnType<typeof createPluginRegistryFixture>,
  origin: "bundled" | "workspace" = "bundled",
) {
  let api: OpenClawPluginApi | undefined;
  registerTestPlugin({
    ...fixture,
    record: createPluginRecord({ id, name, origin }),
    register(value) {
      api = value;
    },
  });
  return api;
}

function eventEmitter(api: Pick<OpenClawPluginApi, "agent"> | undefined, runId: string) {
  return (
    stream: Parameters<OpenClawPluginApi["agent"]["events"]["emitAgentEvent"]>[0]["stream"],
    data: Parameters<OpenClawPluginApi["agent"]["events"]["emitAgentEvent"]>[0]["data"],
    sessionKey?: string,
  ) =>
    api?.agent.events.emitAgentEvent({
      runId,
      stream,
      data,
      ...(sessionKey === undefined ? {} : { sessionKey }),
    });
}

describe("plugin session actions", () => {
  // The Gateway installs the profile catalog before admitting requests; this
  // harness supplies its shared-Gateway fact as a Gateway with several people.
  beforeEach(() => {
    vi.spyOn(profiles, "hasMultipleResidentSessionSharingIdentities").mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setActivePluginRegistry(createEmptyPluginRegistry());
    resetAgentEventsForTest();
  });

  it("does not expose thrown plugin details", async () => {
    const pluginId = "session-action-validation-fixture";
    const { registry } = registerActionFixture({
      id: pluginId,
      register(api) {
        api.session.controls.registerSessionAction({
          id: "throws-secret",
          handler() {
            throw new Error("private plugin detail");
          },
        });
      },
    });
    setActivePluginRegistry(registry.registry);
    const error = requireHookError(await callAction(pluginId, "throws-secret"));
    expect(error).toEqual({ code: "UNAVAILABLE", message: "plugin session action failed" });
    expect(JSON.stringify(error)).not.toContain("private plugin detail");
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
            api.session.controls.registerSessionAction({ id, requiredScopes, handler });
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
      const response = await callAction(pluginId, actionId, undefined, scopes, true);
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
          client: actionClient(scopes),
        });
      }
    });
  });

  it("passes a defensive copy of client scopes to session action handlers", async () => {
    let handlerScopes: string[] | undefined;
    const originalScopes = [READ_SCOPE];
    installAction("scope-copy-fixture", {
      id: "mutate",
      requiredScopes: [READ_SCOPE],
      handler: ({ client }) => {
        handlerScopes = client?.scopes;
        client?.scopes.push(APPROVALS_SCOPE);
        return { result: { ok: true } };
      },
    });
    const response = await callAction("scope-copy-fixture", "mutate", undefined, originalScopes);
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
    installAction(
      "failed-action-plugin",
      { id: "stale", requiredScopes: [READ_SCOPE], handler },
      "error",
    );
    const staleAction = await callPluginSessionActionForTest(
      {
        body: { pluginId: "failed-action-plugin", actionId: "stale" },
        scopes: [READ_SCOPE],
      },
      true,
    );
    const staleActionError = requireHookError(staleAction);
    expect(staleActionError).toMatchObject({
      code: "UNAVAILABLE",
      message: "unknown plugin session action: failed-action-plugin/stale",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("emits plugin-attributed agent events through the plugin API", () => {
    const observed: unknown[] = [];
    const unsubscribe = onAgentEvent((event) => observed.push(event));
    const { config, registry } = createPluginRegistryFixture();
    const bundledApi = captureEventApi("event-plugin", "Event Plugin", { config, registry });
    const workspaceApi = captureEventApi(
      "workspace-event-plugin",
      "Workspace Event Plugin",
      { config, registry },
      "workspace",
    );
    setActivePluginRegistry(registry.registry);
    const emitBundled = eventEmitter(bundledApi, "run-emit");
    const emitWorkspace = eventEmitter(workspaceApi, "run-emit");
    try {
      expect(emitBundled("approval", { state: "queued" }, " agent:main:main ")).toEqual({
        emitted: true,
        stream: "approval",
      });
      expect(emitBundled("lifecycle", { phase: "start" })).toEqual({
        emitted: false,
        reason: "lifecycle start requires a finite startedAt timestamp",
      });
      expect(emitBundled("lifecycle", { phase: "start", startedAt: 1_234 })).toEqual({
        emitted: true,
        stream: "lifecycle",
      });
      expect(emitWorkspace("lifecycle", { phase: "end" })).toEqual({
        emitted: false,
        reason: "stream lifecycle is reserved for bundled plugins",
      });
      expect(emitWorkspace("assistant", { text: "spoofed assistant output" })).toEqual({
        emitted: false,
        reason: "stream assistant is reserved for bundled plugins",
      });
      expect(emitWorkspace("other-plugin.workflow", { state: "queued" })).toEqual({
        emitted: false,
        reason: "stream other-plugin.workflow must be scoped to plugin workspace-event-plugin",
      });
      expect(
        emitWorkspace("workspace-event-plugin.workflow", {
          state: "queued",
        }),
      ).toEqual({ emitted: true, stream: "workspace-event-plugin.workflow" });
      expect(
        bundledApi?.agent.events.emitAgentEvent({
          runId: "run-emit",
          stream: "approval",
          data: 1n as never,
        }),
      ).toEqual({ emitted: false, reason: "event data must be JSON-compatible" });
    } finally {
      unsubscribe();
    }
    expect(observed).toHaveLength(3);
    expectObservedEvent(observed, 0, {
      sessionKey: "agent:main:main",
      runId: "run-emit",
      stream: "approval",
      data: {
        state: "queued",
        pluginId: "event-plugin",
        pluginName: "Event Plugin",
      },
    });
    expectObservedEvent(observed, 1, {
      stream: "lifecycle",
      data: {
        phase: "start",
        startedAt: 1_234,
        pluginId: "event-plugin",
        pluginName: "Event Plugin",
      },
    });
    expectObservedEvent(observed, 2, {
      sessionKey: undefined,
      runId: "run-emit",
      stream: "workspace-event-plugin.workflow",
      data: {
        state: "queued",
        pluginId: "workspace-event-plugin",
        pluginName: "Workspace Event Plugin",
      },
    });
  });

  it("blocks agent events from stale and non-activating plugin API closures", () => {
    const observed: unknown[] = [];
    const unsubscribe = onAgentEvent((event) => observed.push(event));
    const { config, registry } = createPluginRegistryFixture();
    const capturedApi = captureEventApi("stale-event-plugin", "Stale Event Plugin", {
      config,
      registry,
    });
    setActivePluginRegistry(registry.registry);
    setActivePluginRegistry(createEmptyPluginRegistry());
    try {
      expect(eventEmitter(capturedApi, "stale-run")("approval", { stale: true })).toEqual({
        emitted: false,
        reason: "plugin is not loaded",
      });
      const makeInactiveRegistry = (activateGlobalSideEffects = true) =>
        createPluginRegistry({
          logger: { info() {}, warn() {}, error() {}, debug() {} },
          runtime: {} as never,
          activateGlobalSideEffects,
        });
      const neverActiveRegistry = makeInactiveRegistry();
      const neverActiveApi = captureEventApi(
        "never-active-event-plugin",
        "Never Active Event Plugin",
        { config, registry: neverActiveRegistry },
      );
      expect(
        eventEmitter(neverActiveApi, "never-active-run")("approval", { inactive: true }),
      ).toEqual({ emitted: false, reason: "plugin is not loaded" });
      const inactiveRegistry = makeInactiveRegistry(false);
      const inactiveApi = captureEventApi("inactive-event-plugin", "Inactive Event Plugin", {
        config,
        registry: inactiveRegistry,
      });
      expect(eventEmitter(inactiveApi, "inactive-run")("approval", { inactive: true })).toEqual({
        emitted: false,
        reason: "global side effects disabled",
      });
    } finally {
      unsubscribe();
    }
    expect(observed).toEqual([]);
  });

  it("keeps agent event delivery after a staged registry rollback", () => {
    const observed: unknown[] = [];
    const unsubscribe = onAgentEvent((event) => observed.push(event));
    const { config, registry } = createPluginRegistryFixture();
    const capturedApi = captureEventApi("reactivated-event-plugin", "Reactivated Event Plugin", {
      config,
      registry,
    });
    setActivePluginRegistry(registry.registry);
    const snapshot = captureActivePluginRegistrySnapshot();
    stageActivePluginRegistry(createEmptyPluginRegistry(), null, "default");
    rollbackStagedPluginRegistry(snapshot);
    try {
      expect(eventEmitter(capturedApi, "reactivated-run")("approval", { active: true })).toEqual({
        emitted: true,
        stream: "approval",
      });
    } finally {
      unsubscribe();
    }
    expect(observed).toHaveLength(1);
    expectObservedEvent(observed, 0, {
      sessionKey: undefined,
      runId: "reactivated-run",
      stream: "approval",
      data: {
        active: true,
        pluginId: "reactivated-event-plugin",
        pluginName: "Reactivated Event Plugin",
      },
    });
  });
});
