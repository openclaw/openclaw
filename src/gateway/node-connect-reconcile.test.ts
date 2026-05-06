import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { NodePairingRequestInput } from "../infra/node-pairing.js";
import { reconcileNodePairingOnConnect } from "./node-connect-reconcile.js";
import type { ConnectParams } from "./protocol/index.js";

function connectParams(commands: string[]): ConnectParams {
  return {
    protocol: "openclaw.gateway.v1",
    client: {
      id: "voice-pe-node",
      displayName: "Voice PE",
      version: "test",
      platform: "esp32-s3",
      deviceFamily: "voice-pe",
    },
    device: { id: "voice-pe-device" },
    role: "node",
    commands,
  } as unknown as ConnectParams;
}

describe("gateway/node-connect-reconcile", () => {
  it("does not let a legacy empty paired command snapshot suppress default Voice PE device.status", async () => {
    const result = await reconcileNodePairingOnConnect({
      cfg: {} as OpenClawConfig,
      connectParams: connectParams(["device.status", "debug.logs", "speaker.diagnostics"]),
      pairedNode: {
        nodeId: "voice-pe-device",
        token: "redacted",
        commands: [],
        createdAtMs: 1,
        approvedAtMs: 1,
      },
      requestPairing: async () => {
        throw new Error("default command reconciliation should not require pairing");
      },
    });

    expect(result.effectiveCommands).toEqual(["device.status"]);
    expect(result.pendingPairing).toBeUndefined();
  });

  it("keeps extended Voice PE diagnostics behind explicit allowCommands and pairing approval", async () => {
    const requested: NodePairingRequestInput[] = [];
    const result = await reconcileNodePairingOnConnect({
      cfg: {
        gateway: {
          nodes: {
            allowCommands: ["debug.logs", "speaker.diagnostics"],
          },
        },
      } as OpenClawConfig,
      connectParams: connectParams(["device.status", "debug.logs", "speaker.diagnostics"]),
      pairedNode: {
        nodeId: "voice-pe-device",
        token: "redacted",
        commands: [],
        createdAtMs: 1,
        approvedAtMs: 1,
      },
      requestPairing: async (input) => {
        requested.push(input);
        return {
          status: "pending",
          request: { ...input, requestId: "req-1", ts: 1 },
          created: true,
        };
      },
    });

    expect(result.effectiveCommands).toEqual(["device.status"]);
    expect(result.pendingPairing?.created).toBe(true);
    expect(requested[0]?.commands).toEqual(["device.status", "debug.logs", "speaker.diagnostics"]);
  });
});
