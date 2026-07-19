import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PairedDevice } from "../../infra/device-pairing.js";
import {
  captureNodePairingGeneration,
  isNodePairingGenerationCurrent,
} from "./node-pairing-generation.js";

const mocks = vi.hoisted(() => ({
  getPairedDevice: vi.fn(),
}));

vi.mock("../../infra/device-pairing.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/device-pairing.js")>(
    "../../infra/device-pairing.js",
  );
  return { ...actual, getPairedDevice: mocks.getPairedDevice };
});

function pairedNode(overrides: Partial<PairedDevice> = {}): PairedDevice {
  return {
    deviceId: "node-1",
    publicKey: "public-key-1",
    role: "node",
    roles: ["node", "operator"],
    tokens: {
      node: {
        token: "node-token-1",
        role: "node",
        scopes: [],
        createdAtMs: 150,
      },
      operator: {
        token: "operator-token-1",
        role: "operator",
        scopes: ["operator.pairing"],
        createdAtMs: 151,
      },
    },
    createdAtMs: 100,
    approvedAtMs: 200,
    nodeSurface: {
      createdAtMs: 300,
      approvedAtMs: 400,
    },
    ...overrides,
  };
}

describe("node pairing generation", () => {
  beforeEach(() => {
    mocks.getPairedDevice.mockReset();
  });

  it("binds work to node-role token and node-surface approval identity", async () => {
    const original = pairedNode();
    mocks.getPairedDevice.mockResolvedValueOnce(original);

    const generation = await captureNodePairingGeneration(original.deviceId);

    expect(generation).toEqual({
      nodeId: "node-1",
      key: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    mocks.getPairedDevice.mockResolvedValueOnce(
      pairedNode({
        tokens: {
          ...original.tokens,
          node: { ...original.tokens!.node!, token: "node-token-2", rotatedAtMs: 500 },
        },
      }),
    );
    await expect(isNodePairingGenerationCurrent(generation!)).resolves.toBe(false);
  });

  it("keeps node work current across unrelated operator approval", async () => {
    const original = pairedNode();
    mocks.getPairedDevice.mockResolvedValueOnce(original);
    const generation = await captureNodePairingGeneration(original.deviceId);

    mocks.getPairedDevice.mockResolvedValueOnce(
      pairedNode({
        approvedAtMs: 201,
        tokens: {
          ...original.tokens,
          operator: {
            ...original.tokens!.operator!,
            token: "operator-token-2",
            rotatedAtMs: 501,
          },
        },
      }),
    );

    await expect(isNodePairingGenerationCurrent(generation!)).resolves.toBe(true);
  });

  it("invalidates node work when the node surface is reapproved", async () => {
    const original = pairedNode();
    mocks.getPairedDevice.mockResolvedValueOnce(original);
    const generation = await captureNodePairingGeneration(original.deviceId);

    mocks.getPairedDevice.mockResolvedValueOnce(
      pairedNode({ nodeSurface: { createdAtMs: 300, approvedAtMs: 401 } }),
    );
    await expect(isNodePairingGenerationCurrent(generation!)).resolves.toBe(false);
  });

  it("rejects admission without a durable approved node role", async () => {
    mocks.getPairedDevice.mockResolvedValueOnce(
      pairedNode({ role: "operator", roles: ["operator"] }),
    );

    await expect(captureNodePairingGeneration("node-1")).resolves.toBeNull();
  });
});
