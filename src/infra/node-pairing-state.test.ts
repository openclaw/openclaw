// Tests authenticated node generations derived from paired-device rows.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureAuthenticatedNodePairingState,
  captureNodePairingGeneration,
} from "./device-pairing-node-state.js";
import type { PairedDevice } from "./device-pairing.js";

const mocks = vi.hoisted(() => ({
  getPairedDevice: vi.fn(),
}));

vi.mock("./device-pairing.js", async () => {
  const actual = await vi.importActual<typeof import("./device-pairing.js")>("./device-pairing.js");
  return { ...actual, getPairedDevice: mocks.getPairedDevice };
});

function pairedNode(overrides: Partial<PairedDevice> = {}): PairedDevice {
  return {
    deviceId: "node-1",
    publicKey: "test-key",
    role: "node",
    roles: ["node", "operator"],
    tokens: {
      node: {
        token: "test-token",
        role: "node",
        scopes: [],
        createdAtMs: 150,
      },
      operator: {
        token: "test-auth-token",
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

function authenticateNode(node: PairedDevice) {
  return captureAuthenticatedNodePairingState({
    nodeId: node.deviceId,
    publicKey: node.publicKey,
    token: node.tokens!.node!.token,
  });
}

describe("node pairing generation", () => {
  beforeEach(() => {
    mocks.getPairedDevice.mockReset();
  });

  it("captures a generation for an approved node-role pairing", async () => {
    const original = pairedNode();
    mocks.getPairedDevice.mockResolvedValueOnce(original);

    const generation = await captureNodePairingGeneration(original.deviceId);

    expect(generation).toEqual({
      nodeId: "node-1",
      key: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it("binds connected sessions to the public key and node token used at authentication", async () => {
    const original = pairedNode();
    mocks.getPairedDevice
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce({ ...original, publicKey: "fake" })
      .mockResolvedValueOnce(
        pairedNode({
          tokens: {
            ...original.tokens,
            node: { ...original.tokens!.node!, token: "decoy-token" },
          },
        }),
      );

    await expect(authenticateNode(original)).resolves.toMatchObject({
      generation: { nodeId: original.deviceId },
    });
    await expect(authenticateNode(original)).resolves.toBeNull();
    await expect(authenticateNode(original)).resolves.toBeNull();
  });

  it("keeps authenticated pairing identity while first surface approval is pending", async () => {
    const original = pairedNode({ nodeSurface: undefined });
    mocks.getPairedDevice.mockResolvedValueOnce(original);

    await expect(authenticateNode(original)).resolves.toEqual({
      identity: {
        nodeId: original.deviceId,
        key: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      generation: null,
      approvedSurface: { caps: [], commands: [], permissions: undefined },
    });
  });

  it("captures the approved surface from the same authenticated row as its generation", async () => {
    const original = pairedNode({
      nodeSurface: {
        createdAtMs: 300,
        approvedAtMs: 400,
        caps: ["screen"],
        commands: ["screen.snapshot"],
        permissions: { accessibility: false },
      },
    });
    mocks.getPairedDevice.mockResolvedValueOnce(original);

    await expect(authenticateNode(original)).resolves.toMatchObject({
      approvedSurface: {
        caps: ["screen"],
        commands: ["screen.snapshot"],
        permissions: { accessibility: false },
      },
    });
    expect(mocks.getPairedDevice).toHaveBeenCalledTimes(1);
  });

  it("keeps pairing identity stable when the pending surface is approved", async () => {
    const pending = pairedNode({ nodeSurface: undefined });
    const approved = pairedNode();
    mocks.getPairedDevice.mockResolvedValueOnce(pending).mockResolvedValueOnce(approved);

    const params = {
      nodeId: pending.deviceId,
      publicKey: pending.publicKey,
      token: pending.tokens!.node!.token,
    };
    const pendingState = await captureAuthenticatedNodePairingState(params);
    const approvedState = await captureAuthenticatedNodePairingState(params);

    expect(pendingState?.generation).toBeNull();
    expect(approvedState?.generation).not.toBeNull();
    expect(approvedState?.identity.key).toBe(pendingState?.identity.key);
  });

  it("rejects admission without an active node token or approved node surface", async () => {
    const original = pairedNode();
    mocks.getPairedDevice
      .mockResolvedValueOnce(pairedNode({ tokens: undefined }))
      .mockResolvedValueOnce(
        pairedNode({
          tokens: {
            ...original.tokens,
            node: { ...original.tokens!.node!, revokedAtMs: 501 },
          },
        }),
      )
      .mockResolvedValueOnce(pairedNode({ nodeSurface: undefined }));

    await expect(captureNodePairingGeneration("node-1")).resolves.toBeNull();
    await expect(captureNodePairingGeneration("node-1")).resolves.toBeNull();
    await expect(captureNodePairingGeneration("node-1")).resolves.toBeNull();
  });

  it("rejects admission without a durable approved node role", async () => {
    mocks.getPairedDevice.mockResolvedValueOnce(
      pairedNode({ role: "operator", roles: ["operator"] }),
    );

    await expect(captureNodePairingGeneration("node-1")).resolves.toBeNull();
  });
});
