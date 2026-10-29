import { describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import type { GatewayComputerService } from "../desktop/computer-service.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { createRemoteControlUiIngressTestContext } from "../remote-control-ui.test-support.js";
import { gatewayConnect } from "../server/client-fixtures.test-support.js";
import { computerHandlers } from "./computer.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./types.js";

type ComputerMethods = Pick<GatewayComputerService, "status" | "invoke">;

function createClient(identity?: AgentRuntimeIdentity): GatewayClient {
  return {
    connId: "computer-operator",
    connect: gatewayConnect(["operator.write"], { id: GATEWAY_CLIENT_IDS.CLI, mode: "cli" }),
    ...(identity ? { internal: { syntheticClient: true, agentRuntimeIdentity: identity } } : {}),
  };
}

function createIdentity(): AgentRuntimeIdentity {
  const operationalRunInstance = { instanceId: "instance-one", runId: "run-one" };
  return {
    kind: "agentRuntime",
    agentId: "main",
    sessionKey: "agent:main:computer",
    operationalRunInstance,
    delegatedAuthority: {
      kind: "local",
      operationalRunInstance,
      lifecycleGeneration: "generation-one",
      claimId: "claim-one",
    },
  };
}

async function invoke(
  method: "computer.status" | "computer.invoke",
  params: Record<string, unknown>,
  service?: ComputerMethods,
  options: Partial<Omit<GatewayRequestHandlerOptions, "context">> & {
    context?: Partial<GatewayRequestContext>;
  } = {},
) {
  const respond = vi.fn();
  const { context, ...requestOptions } = options;
  await computerHandlers[method]!({
    req: { type: "req", id: "request-one", method, params },
    params,
    respond,
    client: createClient(),
    isWebchatConnect: () => false,
    context: { gatewayComputerService: service, ...context },
    ...requestOptions,
  } as GatewayRequestHandlerOptions);
  return respond.mock.calls[0];
}
function deferredInput(ownerSignal: AbortSignal, suspendAt = 1) {
  const entered = createDeferredCore();
  const prepared = createDeferredCore();
  const owners: string[] = [];
  const sideEffect = vi.fn();
  const service = {
    status: vi.fn(),
    invoke: async (request: Parameters<GatewayComputerService["invoke"]>[0]) => {
      owners.push(request.owner);
      expect(request.ownerSignal).toBe(ownerSignal);
      expect(request.ownerSignal).not.toBe(request.signal);
      if (owners.length === suspendAt) {
        entered.resolve();
        await prepared.promise;
      }
      request.assertCurrent();
      sideEffect();
      return {};
    },
  };
  return { service, entered, prepared, owners, sideEffect };
}

const snapshot = {
  command: "screen.snapshot",
  params: {},
  generation: "provider-one",
  idempotencyKey: "snapshot-one",
};
const unavailableStatus = [true, { available: false, configured: false }];

describe("Gateway computer RPC", () => {
  it("retains one ingress execution owner across origin-free RPCs and fences deferred input", async () => {
    const grant = new AbortController();
    const binding = createRemoteControlUiIngressTestContext({
      audienceId: "computer-grant",
      signal: grant.signal,
    });
    const clientForRequest = () => {
      const client = createClient();
      delete client.connId;
      const principal = binding.resolvePrincipal();
      client.authenticatedUserProfile = principal.authenticatedUserProfile;
      client.connectionSignal = new AbortController().signal;
      client.internal = {
        remoteIngressPrincipal: principal,
        operatorRoleActor: principal.operatorRoleActor,
      };
      return client;
    };
    expect(await invoke("computer.status", {}, undefined, { client: clientForRequest() })).toEqual(
      unavailableStatus,
    );
    const { owners, entered, prepared, sideEffect, service } = deferredInput(grant.signal, 2);
    const dispatch = (params = snapshot) =>
      invoke("computer.invoke", params, service, { client: clientForRequest() });
    expect((await dispatch())?.[0]).toBe(true);
    const pending = dispatch({ ...snapshot, idempotencyKey: "snapshot-two" });
    await entered.promise;
    grant.abort();
    prepared.resolve();
    expect((await pending)?.[0]).toBe(false);
    expect(owners[0]).toBe(owners[1]);
    expect(sideEffect).toHaveBeenCalledOnce();
  });
  it("separates readable capability discovery from computer input authority", () => {
    expect([
      authorizeOperatorScopesForMethod("computer.status", ["operator.read"]),
      authorizeOperatorScopesForMethod("computer.invoke", ["operator.read"]),
      authorizeOperatorScopesForMethod("computer.invoke", ["operator.write"]),
    ]).toEqual([
      { allowed: true },
      { allowed: false, missingScope: "operator.write" },
      { allowed: true },
    ]);
  });

  it("allows synthetic capability discovery before run admission", async () => {
    const client = createClient();
    delete client.connId;
    client.internal = { syntheticClient: true };
    const status = vi.fn(async () => ({ available: false, configured: false }));
    expect(
      await invoke("computer.status", { probe: true }, { status, invoke: vi.fn() }, { client }),
    ).toEqual(unavailableStatus);
    expect(status).toHaveBeenCalledExactlyOnceWith({ probe: true });
  });

  it.each([
    ["computer.status", { probe: "false" }, false],
    ["computer.invoke", { ...snapshot, command: "system.run" }, false],
    ["computer.invoke", { ...snapshot, owner: "forged-operator" }, false],
    ["computer.invoke", snapshot, true],
  ] as const)("rejects malformed or unadmitted %s: %j", async (method, params, synthetic) => {
    const client = createClient();
    if (synthetic) {
      client.internal = { syntheticClient: true };
    }
    const dispatch = vi.fn();
    const result = await invoke(method, params, { status: dispatch, invoke: dispatch }, { client });
    expect(result).toMatchObject([
      false,
      undefined,
      { code: synthetic ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST },
    ]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(["invalidation", "disconnect", "revocation"] as const)(
    "prevents desktop dispatch after operator %s during preparation",
    async (retirement) => {
      const client = createClient();
      const controller = new AbortController();
      const requestController = new AbortController();
      client.connectionSignal = controller.signal;
      const { entered, prepared, sideEffect, service } = deferredInput(controller.signal);
      let current = true;
      const result = invoke("computer.invoke", snapshot, service, {
        client,
        signal: requestController.signal,
        hasCurrentClientAuthority: () => current,
      });
      await entered.promise;
      if (retirement === "invalidation") {
        client.invalidated = true;
      } else if (retirement === "disconnect") {
        controller.abort();
      } else {
        current = false;
      }
      prepared.resolve();
      expect((await result)?.[0]).toBe(false);
      expect(sideEffect).not.toHaveBeenCalled();
    },
  );

  it("keeps run ownership stable across connections and limits retired runs to owned cleanup", async () => {
    const identity = createIdentity();
    const owners: string[] = [];
    let active = true;
    const dispatch = vi.fn(async (request: Parameters<GatewayComputerService["invoke"]>[0]) => {
      expect(request.ownerSignal).toBeUndefined();
      owners.push(request.owner);
      await Promise.resolve();
      request.assertCurrent();
      return { captured: true };
    });
    const service = {
      invoke: dispatch,
      status: async () => ({ configured: true, available: true }),
    };
    const context: Partial<GatewayRequestContext> = {
      validateAgentRuntimeApprovalAuthority: (candidate: AgentRuntimeIdentity) =>
        candidate === identity && active,
    };
    const first = createClient(identity);
    first.connectionSignal = new AbortController().signal;
    const second = { ...createClient(identity), connId: "computer-next-connection" };
    for (const client of [first, second]) {
      expect(await invoke("computer.invoke", snapshot, service, { client, context })).toEqual([
        true,
        { payload: { captured: true } },
      ]);
    }
    expect(owners[0]).toBe(owners[1]);
    active = false;
    const invokeRetired = (params: Record<string, unknown>) =>
      invoke("computer.invoke", params, service, { client: second, context });
    expect((await invokeRetired(snapshot))?.[0]).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(2);
    const closed = await invokeRetired({
      ...snapshot,
      command: "computer.act",
      params: { action: "__close_execution", executionId: "execution-one" },
    });
    expect(closed?.[0]).toBe(true);
    expect(owners[2]).toBe(owners[0]);
  });
});
