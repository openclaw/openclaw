/**
 * Node connect reconciliation tests.
 */
import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { ConnectParams } from "../../packages/gateway-protocol/src/index.js";
import type { NodePairingPairedNode, NodePairingRequestInput } from "../infra/node-pairing.js";
import { reconcileNodePairingOnConnect } from "./node-connect-reconcile.js";

function makeNodeConnectParams(overrides?: Partial<ConnectParams>): ConnectParams {
  return {
    minProtocol: 1,
    maxProtocol: 1,
    client: {
      id: "openclaw-ios",
      version: "test",
      platform: "ios",
      mode: "node",
    },
    commands: ["canvas.snapshot"],
    ...overrides,
  };
}

function makePairedNode(overrides?: Partial<NodePairingPairedNode>): NodePairingPairedNode {
  return {
    nodeId: "openclaw-ios",
    token: "token-1",
    createdAtMs: 1,
    approvedAtMs: 1,
    ...overrides,
  };
}

function makePendingPairingRequest(requestId: string) {
  return vi.fn(async (input: NodePairingRequestInput) => ({
    status: "pending" as const,
    request: { ...input, requestId, ts: 1 },
    created: true,
  }));
}

function expectNodePairingRequest(
  requestPairing: ReturnType<typeof makePendingPairingRequest>,
  expected: Partial<NodePairingRequestInput>,
) {
  expect(requestPairing).toHaveBeenCalledWith({
    nodeId: "openclaw-ios",
    clientId: undefined,
    clientMode: undefined,
    displayName: undefined,
    platform: "ios",
    version: "test",
    deviceFamily: undefined,
    modelIdentifier: undefined,
    caps: [],
    commands: [],
    permissions: undefined,
    remoteIp: undefined,
    ...expected,
  });
}

describe("reconcileNodePairingOnConnect", () => {
  it("includes declared permissions in pending node pairing requests", async () => {
    const requestPairing = makePendingPairingRequest("req-1");

    await reconcileNodePairingOnConnect({
      cfg: {} as never,
      connectParams: makeNodeConnectParams({
        permissions: { camera: true, notifications: false },
      }),
      pairedNode: null,
      requestPairing,
    });

    expectNodePairingRequest(requestPairing, {
      permissions: { camera: true, notifications: false },
    });
  });

  it("keeps first-time pending node surfaces declared but not effective", async () => {
    const requestPairing = makePendingPairingRequest("req-pending");

    const result = await reconcileNodePairingOnConnect({
      cfg: {} as never,
      connectParams: makeNodeConnectParams({
        client: {
          id: GATEWAY_CLIENT_IDS.NODE_HOST,
          version: "test",
          platform: "macos",
          deviceFamily: "Mac",
          mode: GATEWAY_CLIENT_MODES.NODE,
        },
        caps: ["talk"],
        commands: ["system.run"],
        permissions: { camera: true },
      }),
      pairedNode: null,
      requestPairing,
    });

    expect(result.declaredCaps).toEqual(["talk"]);
    expect(result.effectiveCaps).toEqual([]);
    expect(result.declaredCommands).toEqual(["system.run"]);
    expect(result.effectiveCommands).toEqual([]);
    expect(result.declaredPermissions).toEqual({ camera: true });
    expect(result.effectivePermissions).toBeUndefined();
    expect(requestPairing).toHaveBeenCalledWith(
      expect.objectContaining({
        caps: ["talk"],
        commands: ["system.run"],
        permissions: { camera: true },
      }),
    );
  });

  it.each([
    ["conflicts with device family", { deviceFamily: "iPhone" }],
    ["omits device family", {}],
  ])("filters host commands when canonical platform %s", async (_label, clientExtra) => {
    const requestPairing = makePendingPairingRequest("req-mismatch");

    const result = await reconcileNodePairingOnConnect({
      cfg: {} as never,
      connectParams: makeNodeConnectParams({
        client: {
          id: "openclaw-ios",
          version: "test",
          platform: "macos",
          mode: "node",
          ...clientExtra,
        },
        commands: ["system.run", "system.which"],
      }),
      pairedNode: null,
      requestPairing,
    });

    expect(result.declaredCommands).toEqual([]);
    expect(requestPairing).toHaveBeenCalledWith(
      expect.objectContaining({
        commands: [],
      }),
    );
  });

  it("requires a fresh pairing request when paired node capabilities change", async () => {
    const requestPairing = makePendingPairingRequest("req-caps");

    const result = await reconcileNodePairingOnConnect({
      cfg: {} as never,
      connectParams: makeNodeConnectParams({
        caps: ["camera", "screen"],
        commands: [],
      }),
      pairedNode: makePairedNode({
        caps: ["camera"],
        commands: [],
      }),
      requestPairing,
    });

    expectNodePairingRequest(requestPairing, {
      caps: ["camera", "screen"],
      commands: [],
    });
    expect(result.effectiveCaps).toEqual(["camera"]);
    expect(result.effectiveCommands).toEqual([]);
    expect(result.declaredCaps).toEqual(["camera", "screen"]);
    expect(result.pendingPairing?.request.requestId).toBe("req-caps");
  });

  it("keeps the approved surface when paired-node reapproval is throttled", async () => {
    const requestPairing = vi.fn(async () => null);

    const result = await reconcileNodePairingOnConnect({
      cfg: {} as never,
      connectParams: makeNodeConnectParams({
        caps: ["camera", "screen"],
        commands: [],
      }),
      pairedNode: makePairedNode({
        caps: ["camera"],
        commands: [],
      }),
      requestPairing,
    });

    expect(requestPairing).toHaveBeenCalledOnce();
    expect(result.effectiveCaps).toEqual(["camera"]);
    expect(result.effectiveCommands).toEqual([]);
    expect(result.declaredCaps).toEqual(["camera", "screen"]);
    expect(result.pendingPairing).toBeUndefined();
    expect(result.shouldClearPendingPairings).toBeUndefined();
  });

  it("defers stale pending reapproval cleanup when the node returns to its approved surface", async () => {
    const requestPairing = makePendingPairingRequest("req-unused");

    const result = await reconcileNodePairingOnConnect({
      cfg: {} as never,
      connectParams: makeNodeConnectParams({
        caps: ["camera"],
        commands: ["canvas.snapshot"],
      }),
      pairedNode: makePairedNode({
        caps: ["camera"],
        commands: ["canvas.snapshot"],
      }),
      requestPairing,
    });

    expect(requestPairing).not.toHaveBeenCalled();
    expect(result.shouldClearPendingPairings).toBe(true);
  });

  it("requires a fresh pairing request when paired node permissions change", async () => {
    const requestPairing = makePendingPairingRequest("req-permissions");

    const result = await reconcileNodePairingOnConnect({
      cfg: {} as never,
      connectParams: makeNodeConnectParams({
        commands: [],
        permissions: { camera: true, notifications: false },
      }),
      pairedNode: makePairedNode({
        commands: [],
        permissions: { camera: true },
      }),
      requestPairing,
    });

    expectNodePairingRequest(requestPairing, {
      commands: [],
      permissions: { camera: true, notifications: false },
    });
    expect(result.effectiveCommands).toEqual([]);
    expect(result.effectivePermissions).toEqual({ camera: true, notifications: false });
    expect(result.pendingPairing?.request.requestId).toBe("req-permissions");
  });

  it("applies declared capability and permission downgrades to the live surface", async () => {
    const requestPairing = makePendingPairingRequest("req-downgrade");

    const result = await reconcileNodePairingOnConnect({
      cfg: {} as never,
      connectParams: makeNodeConnectParams({
        caps: ["camera"],
        commands: [],
        permissions: { camera: false },
      }),
      pairedNode: makePairedNode({
        caps: ["camera", "screen"],
        commands: [],
        permissions: { camera: true, notifications: true },
      }),
      requestPairing,
    });

    expectNodePairingRequest(requestPairing, {
      caps: ["camera"],
      commands: [],
      permissions: { camera: false },
    });
    expect(result.effectiveCaps).toEqual(["camera"]);
    expect(result.effectiveCommands).toEqual([]);
    expect(result.effectivePermissions).toEqual({ camera: false });
    expect(result.pendingPairing?.request.requestId).toBe("req-downgrade");
  });

  // Regression coverage for openclaw/openclaw#87058 and #97967: an Android
  // node-connect declaration was being collapsed to an empty effective
  // surface, leaving an already device-approved Android node permanently
  // unable to invoke any command (including always-safe commands like
  // device.info), with no user-facing way to approve the resulting upgrade
  // request.
  describe("android node-surface auto-adoption", () => {
    function makeAndroidNodeConnectParams(overrides?: Partial<ConnectParams>): ConnectParams {
      return makeNodeConnectParams({
        client: {
          id: GATEWAY_CLIENT_IDS.ANDROID_APP,
          version: "test",
          platform: "android",
          deviceFamily: "android",
          mode: GATEWAY_CLIENT_MODES.NODE,
        },
        caps: ["device", "contacts"],
        commands: ["device.info", "contacts.search"],
        ...overrides,
      });
    }

    it("auto-adopts the declared platform-safe surface on a first-time Android node connect", async () => {
      const requestPairing = makePendingPairingRequest("req-android-first");

      const result = await reconcileNodePairingOnConnect({
        cfg: {} as never,
        connectParams: makeAndroidNodeConnectParams(),
        pairedNode: null,
        requestPairing,
      });

      expect(result.declaredCaps).toEqual(["device", "contacts"]);
      expect(result.effectiveCaps).toEqual(["device", "contacts"]);
      expect(result.declaredCommands).toEqual(["device.info", "contacts.search"]);
      expect(result.effectiveCommands).toEqual(["device.info", "contacts.search"]);
      // A pending pairing record is still created (for visibility/audit via
      // `openclaw nodes status`), but it no longer gates the live surface.
      expect(result.pendingPairing?.request.requestId).toBe("req-android-first");
    });

    it("auto-adopts versioned first-party Android metadata", async () => {
      const requestPairing = makePendingPairingRequest("req-android-versioned");

      const result = await reconcileNodePairingOnConnect({
        cfg: {} as never,
        connectParams: makeAndroidNodeConnectParams({
          client: {
            id: GATEWAY_CLIENT_IDS.ANDROID_APP,
            version: "test",
            platform: "Android 16",
            deviceFamily: "Android",
            mode: GATEWAY_CLIENT_MODES.NODE,
          },
        }),
        pairedNode: null,
        requestPairing,
      });

      expect(result.effectiveCaps).toEqual(["device", "contacts"]);
      expect(result.effectiveCommands).toEqual(["device.info", "contacts.search"]);
      expect(result.pendingPairing?.request.requestId).toBe("req-android-versioned");
    });

    it("does not auto-adopt Android-shaped metadata from a non-Android client id", async () => {
      const requestPairing = makePendingPairingRequest("req-android-spoof");

      const result = await reconcileNodePairingOnConnect({
        cfg: {} as never,
        connectParams: makeAndroidNodeConnectParams({
          client: {
            id: GATEWAY_CLIENT_IDS.NODE_HOST,
            version: "test",
            platform: "Android 16",
            deviceFamily: "Android",
            mode: GATEWAY_CLIENT_MODES.NODE,
          },
        }),
        pairedNode: null,
        requestPairing,
      });

      expect(result.declaredCommands).toEqual(["device.info", "contacts.search"]);
      expect(result.effectiveCaps).toEqual([]);
      expect(result.effectiveCommands).toEqual([]);
      expect(result.pendingPairing?.request.requestId).toBe("req-android-spoof");
    });

    it("does not auto-adopt commands outside the Android platform allowlist", async () => {
      const requestPairing = makePendingPairingRequest("req-android-unsafe");

      const result = await reconcileNodePairingOnConnect({
        cfg: {} as never,
        connectParams: makeAndroidNodeConnectParams({
          commands: ["device.info", "system.run"],
        }),
        pairedNode: null,
        requestPairing,
      });

      // system.run is not in the android platform allowlist, so it's dropped
      // before reconciliation ever sees it -- auto-adoption can't widen the
      // surface beyond what's already platform-safe.
      expect(result.declaredCommands).toEqual(["device.info"]);
      expect(result.effectiveCommands).toEqual(["device.info"]);
    });

    it("does not auto-adopt an existing empty approved Android node surface", async () => {
      const requestPairing = makePendingPairingRequest("req-android-empty-upgrade");

      const result = await reconcileNodePairingOnConnect({
        cfg: {} as never,
        connectParams: makeAndroidNodeConnectParams(),
        pairedNode: makePairedNode({
          nodeId: "openclaw-android",
          caps: [],
          commands: [],
        }),
        requestPairing,
      });

      expect(requestPairing).toHaveBeenCalledOnce();
      expect(result.effectiveCaps).toEqual([]);
      expect(result.effectiveCommands).toEqual([]);
      expect(result.shouldClearPendingPairings).toBeUndefined();
      expect(result.pendingPairing?.request.requestId).toBe("req-android-empty-upgrade");
    });

    it("still requires explicit reapproval once an Android node has a non-empty approved surface", async () => {
      const requestPairing = makePendingPairingRequest("req-android-upgrade");

      const result = await reconcileNodePairingOnConnect({
        cfg: {} as never,
        connectParams: makeAndroidNodeConnectParams({
          caps: ["device", "contacts", "calendar"],
          commands: ["device.info", "contacts.search", "calendar.events"],
        }),
        pairedNode: makePairedNode({
          nodeId: "openclaw-android",
          caps: ["device"],
          commands: ["device.info"],
        }),
        requestPairing,
      });

      // Once a real node-surface approval exists, the legacy-migration
      // shortcut no longer applies: new caps/commands beyond what's already
      // approved still go through the normal upgrade-approval path.
      expect(requestPairing).toHaveBeenCalledOnce();
      expect(result.effectiveCaps).toEqual(["device"]);
      expect(result.effectiveCommands).toEqual(["device.info"]);
      expect(result.pendingPairing?.request.requestId).toBe("req-android-upgrade");
    });
  });
});
