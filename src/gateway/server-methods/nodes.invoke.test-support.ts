import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi, type Mock } from "vitest";
import type { NodeInvokeParams, NodeInvokeResult } from "../node-invoke.types.js";
import type { GatewayRequestHandler, GatewayRequestHandlerOptions } from "./types.js";

export type RespondCall = Parameters<GatewayRequestHandlerOptions["respond"]>;

export async function invokeNodeRequest(
  handler: GatewayRequestHandler,
  context: GatewayRequestHandlerOptions["context"],
  client: GatewayRequestHandlerOptions["client"],
  method: string,
  params: Record<string, unknown>,
  requestId = method,
) {
  const respond = vi.fn();
  await handler({
    req: { type: "req", id: requestId, method, params },
    params,
    context,
    client,
    isWebchatConnect: () => false,
    respond,
  });
  return respond;
}

type MockCallSource = Pick<Mock, "mock">;

export type TestNodeSession = {
  nodeId: string;
  connId?: string;
  pairingGeneration?: string;
  commands: string[];
  declaredCommands?: string[];
  platform?: string;
  client?: { invalidated?: boolean };
};

function mockCall(source: MockCallSource, callIndex = 0): ReadonlyArray<unknown> {
  const call = source.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected mock call ${callIndex}`);
  }
  return call;
}

export function firstRespondCall(source: MockCallSource): RespondCall {
  return mockCall(source) as RespondCall;
}

export function mockArg(source: MockCallSource, callIndex: number, argIndex: number) {
  return mockCall(source, callIndex)[argIndex];
}

export function createNodeInvokeTestHarness({
  getRuntimeConfig,
  nodeHandlers,
}: {
  getRuntimeConfig: () => unknown;
  nodeHandlers: (typeof import("./nodes.js"))["nodeHandlers"];
}) {
  return async (params: {
    nodeRegistry: {
      get: (nodeId: string) => TestNodeSession | undefined;
      getForPairingGeneration?: (
        nodeId: string,
        pairingGeneration: string,
      ) => TestNodeSession | undefined;
      invoke: (payload: NodeInvokeParams) => Promise<NodeInvokeResult>;
    };
    client?: unknown;
    respond?: ReturnType<typeof vi.fn>;
    requestId?: string;
    signal?: AbortSignal;
    requestParams?: Partial<Record<string, unknown>>;
    validateAgentRuntimeApprovalAuthority?: () => boolean;
    execApprovalManager?: {
      projectDecisionIfActive: (id: string, decision: string) => string | null;
      retainForHandoff?: (id: string) => (() => void) | null;
    };
  }) => {
    const respond = params.respond ?? vi.fn();
    const nodeRegistry = {
      ...params.nodeRegistry,
      getForPairingGeneration:
        params.nodeRegistry.getForPairingGeneration ??
        ((nodeId: string, _pairingGeneration: string) => params.nodeRegistry.get(nodeId)),
    };
    const execApprovalManager = params.execApprovalManager
      ? {
          retainForHandoff: () => () => {},
          ...params.execApprovalManager,
        }
      : undefined;
    await expectDefined(
      nodeHandlers["node.invoke"],
      'nodeHandlers["node.invoke"] test invariant',
    )({
      params: {
        nodeId: "ios-node-1",
        command: "camera.capture",
        params: { quality: "high" },
        timeoutMs: 5000,
        idempotencyKey: "idem-node-invoke",
        ...params.requestParams,
      },
      respond: respond as never,
      context: {
        nodeRegistry,
        execApprovalManager,
        logGateway: { info: vi.fn(), warn: vi.fn() },
        getRuntimeConfig,
        validateAgentRuntimeApprovalAuthority: params.validateAgentRuntimeApprovalAuthority,
      } as never,
      client: (params.client ?? null) as never,
      signal: params.signal,
      req: { type: "req", id: params.requestId ?? "req-node-invoke", method: "node.invoke" },
      isWebchatConnect: () => false,
    });
    return respond;
  };
}

export function createOperatorClient(params?: {
  scopes?: string[];
  pluginRuntimeOwnerId?: string;
}) {
  return {
    connect: {
      role: "operator" as const,
      scopes: params?.scopes ?? ["operator.write"],
      client: {
        id: "operator-test",
        mode: "backend" as const,
        name: "operator-test",
        platform: "node",
        version: "test",
      },
    },
    internal: params?.pluginRuntimeOwnerId
      ? { pluginRuntimeOwnerId: params.pluginRuntimeOwnerId }
      : {},
  };
}

export function registerNodeInvokeUploadTests({
  mocks,
  invokeNode,
}: {
  mocks: {
    getRuntimeConfig: Pick<Mock<() => unknown>, "mockReturnValue">;
    resolveNodeCommandAllowlist: { mockReturnValue(value: Set<string>): unknown };
    sanitizeNodeInvokeParamsForForwarding: Pick<
      Mock<(params: { rawParams: unknown }) => { ok: boolean; params: unknown }>,
      "mockImplementationOnce"
    >;
  };
  invokeNode: ReturnType<typeof createNodeInvokeTestHarness>;
}): void {
  const setUploads = (enabled: boolean) =>
    mocks.getRuntimeConfig.mockReturnValue({ gateway: { uploads: { enabled } } });
  it.each(["before lookup", "during preparation", "internal service"])(
    "enforces terminal upload policy: %s",
    async (stage) => {
      const internal = stage === "internal service";
      setUploads(stage === "during preparation");
      const nodeRegistry = {
        get:
          stage === "before lookup"
            ? vi.fn()
            : vi.fn(() => ({ nodeId: "upload-node", commands: ["terminal.upload"] })),
        invoke: vi.fn(),
      };
      if (stage !== "before lookup") {
        mocks.resolveNodeCommandAllowlist.mockReturnValue(new Set(["terminal.upload"]));
      }
      if (stage === "during preparation") {
        mocks.sanitizeNodeInvokeParamsForForwarding.mockImplementationOnce(({ rawParams }) => {
          setUploads(false);
          return { ok: true, params: rawParams };
        });
      }
      if (internal) {
        nodeRegistry.invoke.mockResolvedValue({
          ok: true,
          payloadJSON: '{"path":"/uploads/proof"}',
        });
      }
      const bytes =
        stage === "before lookup"
          ? { contentBase64: "", internal: { syntheticClient: true } }
          : { name: "proof", contentBase64: "cHJvb2Y=" };
      const respond = await invokeNode({
        nodeRegistry,
        client: {
          ...createOperatorClient({ scopes: ["operator.admin"] }),
          internal: internal ? { syntheticClient: true } : {},
        },
        requestParams: { nodeId: "upload-node", command: "terminal.upload", params: bytes },
      });
      if (internal) {
        expect(firstRespondCall(respond)[0]).toBe(true);
        expect(nodeRegistry.invoke).toHaveBeenCalledOnce();
      } else {
        expect(firstRespondCall(respond)).toMatchObject([
          false,
          undefined,
          {
            ...(stage === "before lookup" ? { code: "FORBIDDEN" } : {}),
            details: { code: "UPLOADS_DISABLED" },
          },
        ]);
        expect(nodeRegistry.invoke).not.toHaveBeenCalled();
      }
      if (stage === "before lookup") {
        expect(nodeRegistry.get).not.toHaveBeenCalled();
      }
    },
  );
}
