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
    roles: ["node"],
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

  it("binds work to durable pairing and node-surface approval identity", async () => {
    const original = pairedNode();
    mocks.getPairedDevice.mockResolvedValueOnce(original);

    const generation = await captureNodePairingGeneration(original.deviceId);

    expect(generation).toEqual({
      nodeId: "node-1",
      key: ["public-key-1", 100, 200, 400].join("\0"),
    });
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
