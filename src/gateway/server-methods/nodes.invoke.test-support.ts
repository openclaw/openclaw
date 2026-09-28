import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi, type Mock } from "vitest";

export type RespondCall = [
  boolean,
  unknown?,
  {
    code?: number;
    message?: string;
    details?: unknown;
  }?,
];

type MockCallSource = {
  mock: {
    calls: ArrayLike<ReadonlyArray<unknown>>;
  };
};

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

function makeNodeInvokeParams(overrides?: Partial<Record<string, unknown>>) {
  return {
    nodeId: "ios-node-1",
    command: "camera.capture",
    params: { quality: "high" },
    timeoutMs: 5000,
    idempotencyKey: "idem-node-invoke",
    ...overrides,
  };
}

export function createNodeInvokeTestHarness({
  getRuntimeConfig,
  nodeHandlers,
}: {
  getRuntimeConfig: () => unknown;
  nodeHandlers: (typeof import("./nodes.js"))["nodeHandlers"];
}) {
  async function invokeNode(params: {
    nodeRegistry: {
      get: (nodeId: string) => TestNodeSession | undefined;
      getForPairingGeneration?: (
        nodeId: string,
        pairingGeneration: string,
      ) => TestNodeSession | undefined;
      invoke: (payload: {
        nodeId: string;
        command: string;
        params?: unknown;
        timeoutMs?: number;
        signal?: AbortSignal;
        idempotencyKey?: string;
        expectedPairingGeneration?: string;
      }) => Promise<{
        ok: boolean;
        payload?: unknown;
        payloadJSON?: string | null;
        error?: { code?: string; message?: string } | null;
      }>;
    };
    client?: unknown;
    signal?: AbortSignal;
    requestParams?: Partial<Record<string, unknown>>;
    validateAgentRuntimeApprovalAuthority?: () => boolean;
    execApprovalManager?: {
      projectDecisionIfActive: (id: string, decision: string) => string | null;
      retainForHandoff?: (id: string) => (() => void) | null;
    };
  }) {
    const respond = vi.fn();
    const logGateway = {
      info: vi.fn(),
      warn: vi.fn(),
    };
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
      params: makeNodeInvokeParams(params.requestParams),
      respond: respond as never,
      context: {
        nodeRegistry,
        execApprovalManager,
        logGateway,
        getRuntimeConfig,
        validateAgentRuntimeApprovalAuthority: params.validateAgentRuntimeApprovalAuthority,
      } as never,
      client: (params.client ?? null) as never,
      signal: params.signal,
      req: { type: "req", id: "req-node-invoke", method: "node.invoke" },
      isWebchatConnect: () => false,
    });
    return respond;
  }

  return invokeNode;
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
  it.each(["terminal.upload", "file.write", "browser.proxy.upload.v1"])(
    "blocks external %s upload bytes before node lookup, including spoofed internal params",
    async (command) => {
      mocks.getRuntimeConfig.mockReturnValue({ gateway: { uploads: { enabled: false } } });
      const nodeRegistry = { get: vi.fn(), invoke: vi.fn() };
      const respond = await invokeNode({
        nodeRegistry,
        client: createOperatorClient({ scopes: ["operator.admin"] }),
        requestParams: {
          command,
          params: { contentBase64: "", internal: { syntheticClient: true } },
        },
      });
      expect(firstRespondCall(respond)).toMatchObject([
        false,
        undefined,
        {
          code: "FORBIDDEN",
          details: { code: "UPLOADS_DISABLED" },
        },
      ]);
      expect(nodeRegistry.get).not.toHaveBeenCalled();
      expect(nodeRegistry.invoke).not.toHaveBeenCalled();
    },
  );

  it("rejects terminal bytes when uploads are disabled during dispatch preparation", async () => {
    mocks.getRuntimeConfig.mockReturnValue({ gateway: { uploads: { enabled: true } } });
    mocks.resolveNodeCommandAllowlist.mockReturnValue(new Set(["terminal.upload"]));
    mocks.sanitizeNodeInvokeParamsForForwarding.mockImplementationOnce(({ rawParams }) => {
      mocks.getRuntimeConfig.mockReturnValue({ gateway: { uploads: { enabled: false } } });
      return { ok: true, params: rawParams };
    });
    const nodeRegistry = {
      get: vi.fn(() => ({ nodeId: "upload-node", commands: ["terminal.upload"] })),
      invoke: vi.fn(),
    };
    const respond = await invokeNode({
      nodeRegistry,
      client: createOperatorClient({ scopes: ["operator.admin"] }),
      requestParams: {
        nodeId: "upload-node",
        command: "terminal.upload",
        params: { name: "proof", contentBase64: "cHJvb2Y=" },
      },
    });
    expect(firstRespondCall(respond)).toMatchObject([
      false,
      undefined,
      { details: { code: "UPLOADS_DISABLED" } },
    ]);
    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
  });

  it.each([
    { label: "default-enabled", enabled: undefined, synthetic: false },
    { label: "explicit-enabled", enabled: true, synthetic: false },
    { label: "internal-service", enabled: false, synthetic: true },
  ])("preserves terminal upload dispatch for $label", async ({ enabled, synthetic }) => {
    mocks.getRuntimeConfig.mockReturnValue({ gateway: { uploads: { enabled } } });
    mocks.resolveNodeCommandAllowlist.mockReturnValue(new Set(["terminal.upload"]));
    const nodeRegistry = {
      get: vi.fn(() => ({ nodeId: "upload-node", commands: ["terminal.upload"] })),
      invoke: vi.fn().mockResolvedValue({ ok: true, payloadJSON: '{"path":"/uploads/proof"}' }),
    };
    const client = createOperatorClient({ scopes: ["operator.admin"] });
    const respond = await invokeNode({
      nodeRegistry,
      client: synthetic ? { ...client, internal: { syntheticClient: true } } : client,
      requestParams: {
        nodeId: "upload-node",
        command: "terminal.upload",
        params: { name: "proof", contentBase64: "cHJvb2Y=" },
      },
    });
    expect(firstRespondCall(respond)[0]).toBe(true);
    expect(nodeRegistry.invoke).toHaveBeenCalledOnce();
  });
}
