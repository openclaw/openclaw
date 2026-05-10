import { beforeEach, describe, expect, it, vi } from "vitest";
import { listDevicePairing } from "../../infra/device-pairing.js";
import { listNodePairing, requestNodePairing } from "../../infra/node-pairing.js";
import { nodeHandlers } from "./nodes.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const {
  approveNodePairingMock,
  listDevicePairingMock,
  listNodePairingMock,
  rejectNodePairingMock,
  removePairedNodeMock,
  renamePairedNodeMock,
  requestNodePairingMock,
  verifyNodeTokenMock,
} = vi.hoisted(() => ({
  approveNodePairingMock: vi.fn(),
  listDevicePairingMock: vi.fn(),
  listNodePairingMock: vi.fn(),
  rejectNodePairingMock: vi.fn(),
  removePairedNodeMock: vi.fn(),
  renamePairedNodeMock: vi.fn(),
  requestNodePairingMock: vi.fn(),
  verifyNodeTokenMock: vi.fn(),
}));

vi.mock("../../infra/device-pairing.js", () => ({
  listDevicePairing: listDevicePairingMock,
}));

vi.mock("../../infra/node-pairing.js", () => ({
  approveNodePairing: approveNodePairingMock,
  listNodePairing: listNodePairingMock,
  rejectNodePairing: rejectNodePairingMock,
  removePairedNode: removePairedNodeMock,
  renamePairedNode: renamePairedNodeMock,
  requestNodePairing: requestNodePairingMock,
  verifyNodeToken: verifyNodeTokenMock,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function createOptions(
  method: string,
  params: Record<string, unknown>,
): GatewayRequestHandlerOptions {
  return {
    req: { type: "req", id: `${method}-req`, method, params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: {
      broadcast: vi.fn(),
      nodeRegistry: {
        listConnected: vi.fn(() => []),
        get: vi.fn(),
      },
      logGateway: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
    },
  } as unknown as GatewayRequestHandlerOptions;
}

async function callNodeMethod(method: keyof typeof nodeHandlers, params: Record<string, unknown>) {
  const opts = createOptions(method, params);
  await nodeHandlers[method]?.(opts);
  return vi.mocked(opts.respond).mock.calls[0];
}

describe("node pairing list cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not let a stale in-flight pairing read repopulate the node list cache after invalidation", async () => {
    const staleDevices = deferred<{ paired: unknown[] }>();
    const staleNodes = deferred<{ paired: unknown[] }>();

    vi.mocked(listDevicePairing).mockReturnValueOnce(staleDevices.promise as never);
    vi.mocked(listNodePairing).mockReturnValueOnce(staleNodes.promise as never);
    vi.mocked(requestNodePairing).mockResolvedValueOnce({
      status: "pending",
      created: false,
      request: { requestId: "req-1", nodeId: "fresh-node" },
    } as never);

    const firstListPromise = callNodeMethod("node.list", {});

    const [requestOk] = await callNodeMethod("node.pair.request", {
      nodeId: "fresh-node",
      platform: "darwin",
    });
    expect(requestOk).toBe(true);

    staleDevices.resolve({ paired: [] });
    staleNodes.resolve({
      paired: [
        {
          nodeId: "stale-node",
          displayName: "Stale Node",
          caps: [],
          commands: [],
        },
      ],
    });
    const [firstOk] = await firstListPromise;
    expect(firstOk).toBe(true);

    vi.mocked(listDevicePairing).mockResolvedValueOnce({ paired: [] } as never);
    vi.mocked(listNodePairing).mockResolvedValueOnce({
      paired: [
        {
          nodeId: "fresh-node",
          displayName: "Fresh Node",
          caps: [],
          commands: [],
        },
      ],
    } as never);

    const [secondOk, secondPayload] = await callNodeMethod("node.list", {});

    expect(secondOk).toBe(true);
    expect(listDevicePairingMock).toHaveBeenCalledTimes(2);
    expect(listNodePairingMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(secondPayload)).toContain("fresh-node");
    expect(JSON.stringify(secondPayload)).not.toContain("stale-node");
  });
});
