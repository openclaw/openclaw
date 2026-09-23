import { describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import type { GatewayComputerService } from "../desktop/computer-service.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { computerHandlers } from "./computer.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./types.js";

function createClient(identity?: AgentRuntimeIdentity): GatewayClient {
  return {
    connId: "computer-operator",
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      role: "operator",
      scopes: ["operator.write"],
      client: { id: GATEWAY_CLIENT_IDS.CLI, version: "test", platform: "test", mode: "cli" },
    },
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
  service?: Pick<GatewayComputerService, "status" | "invoke">,
  options: Partial<Omit<GatewayRequestHandlerOptions, "context">> & {
    context?: Partial<GatewayRequestContext>;
  } = {},
) {
  const respond = vi.fn();
  const { context, ...requestOptions } = options;
  const gatewayComputerService: GatewayComputerService | undefined = service
    ? {
        ...service,
        close: async () => {},
        reconcileRuntimePolicy: async () => {},
        revokeRunAuthority: () => {},
        preparePluginReload: () => ({ drain: async () => {}, resume: () => {} }),
      }
    : undefined;
  await computerHandlers[method]!({
    req: { type: "req", id: "request-one", method, params },
    params,
    respond,
    client: createClient(),
    isWebchatConnect: () => false,
    context: { gatewayComputerService, ...context },
    ...requestOptions,
  } as GatewayRequestHandlerOptions);
  return respond.mock.calls[0];
}

const snapshot = {
  command: "screen.snapshot",
  params: {},
  generation: "provider-one",
  idempotencyKey: "snapshot-one",
};

describe("Gateway computer RPC", () => {
  it("separates readable capability discovery from computer input authority", () => {
    expect(authorizeOperatorScopesForMethod("computer.status", ["operator.read"])).toEqual({
      allowed: true,
    });
    expect(authorizeOperatorScopesForMethod("computer.invoke", ["operator.read"])).toEqual({
      allowed: false,
      missingScope: "operator.write",
    });
    expect(authorizeOperatorScopesForMethod("computer.invoke", ["operator.write"])).toEqual({
      allowed: true,
    });
  });

  it.each([false, true])(
    "allows capability discovery before run admission (synthetic=%s)",
    async (synthetic) => {
      const client = createClient();
      if (synthetic) {
        delete client.connId;
        client.internal = { syntheticClient: true };
      }
      expect(await invoke("computer.status", {}, undefined, { client })).toEqual([
        true,
        { available: false, configured: false },
      ]);
    },
  );

  it.each([
    { ...snapshot, command: "system.run" },
    { ...snapshot, owner: "forged-operator" },
    { ...snapshot, params: [] },
    { ...snapshot, timeoutMs: 0 },
  ])("rejects malformed or authority-bearing wire requests: %j", async (params) => {
    const dispatch = vi.fn();
    const result = await invoke("computer.invoke", params, {
      status: vi.fn(),
      invoke: dispatch,
    });
    expect(result?.[0]).toBe(false);
    expect(result?.[2]).toMatchObject({ code: ErrorCodes.INVALID_REQUEST });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(["invalidation", "disconnect", "revocation"] as const)(
    "prevents desktop dispatch after operator %s during preparation",
    async (retirement) => {
      const started = createDeferredCore();
      const prepared = createDeferredCore();
      const sideEffect = vi.fn();
      const client = createClient();
      const controller = new AbortController();
      const requestController = new AbortController();
      client.connectionSignal = controller.signal;
      let current = true;
      const result = invoke(
        "computer.invoke",
        snapshot,
        {
          status: vi.fn(),
          invoke: async (request) => {
            expect(request.ownerSignal).toBe(controller.signal);
            expect(request.ownerSignal).not.toBe(request.signal);
            started.resolve();
            await prepared.promise;
            request.assertCurrent();
            sideEffect();
            return {};
          },
        },
        { client, signal: requestController.signal, hasCurrentClientAuthority: () => current },
      );
      await started.promise;
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
    const context: Partial<GatewayRequestContext> = {
      gatewayComputerService: {
        invoke: dispatch,
        status: async () => ({ configured: true, available: true }),
        close: async () => {},
        reconcileRuntimePolicy: async () => {},
        revokeRunAuthority: () => {},
        preparePluginReload: () => ({ drain: async () => {}, resume: () => {} }),
      },
      validateAgentRuntimeApprovalAuthority: (candidate: AgentRuntimeIdentity) =>
        candidate === identity && active,
    };
    const first = createClient(identity);
    first.connectionSignal = new AbortController().signal;
    const second = { ...createClient(identity), connId: "computer-next-connection" };
    for (const client of [first, second]) {
      expect(
        await invoke("computer.invoke", snapshot, undefined, {
          client,
          context,
        }),
      ).toEqual([true, { payload: { captured: true } }]);
    }
    expect(owners[0]).toBe(owners[1]);
    active = false;
    expect(
      (
        await invoke("computer.invoke", snapshot, undefined, {
          client: second,
          context,
        })
      )?.[0],
    ).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(
      (
        await invoke(
          "computer.invoke",
          {
            ...snapshot,
            command: "computer.act",
            params: { action: "__close_execution", executionId: "execution-one" },
          },
          undefined,
          {
            client: second,
            context,
          },
        )
      )?.[0],
    ).toBe(true);
    expect(owners[2]).toBe(owners[0]);
  });

  it("rejects a synthetic client without an admitted run", async () => {
    const client = createClient();
    client.internal = { syntheticClient: true };
    const dispatch = vi.fn();
    expect(
      (
        await invoke("computer.invoke", snapshot, { status: vi.fn(), invoke: dispatch }, { client })
      )?.[0],
    ).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
