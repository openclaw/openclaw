/** Gateway health endpoint integration tests. */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, test, vi } from "vitest";
import { writeConfigFile } from "../config/config.js";
import { drainSystemEvents } from "../infra/system-events.js";
import type { SystemPresence } from "../infra/system-presence.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { installGatewayTestHooks, onceMessage, rpcReq } from "./test-helpers.js";

// Health/presence coverage does not exercise post-restart delivery recovery.
// Keep that auto-reply graph in the dedicated restart-sentinel suite.
vi.mock("./server-restart-sentinel.js", () => ({
  recoverPendingProducedSessionDeliveries: vi.fn(async () => undefined),
}));

const presenceTimeout = { timeout: 6_000 };

let harness: GatewayServerHarness;

installGatewayTestHooks({
  scope: "suite",
  setup: async () => {
    const workspace = path.join(
      expectDefined(process.env.OPENCLAW_STATE_DIR, "gateway fixture state directory"),
      "workspace",
    );
    await writeConfigFile({ agents: { defaults: { workspace } } });
    harness = await startGatewayServerHarness();
  },
  cleanup: async () => {
    await harness?.close();
  },
});

test(
  "queues meaningful node presence changes without noisy refreshes",
  presenceTimeout,
  async () => {
    const { ws } = await harness.openClient();

    const instanceId = `presence-beacon-${randomUUID()}`;
    const sessionKey = `agent:main:presence-${randomUUID()}`;
    const text =
      "Node: Relay-Host (10.0.0.9) · app 2.1.0 · last input 7s ago · mode ui · reason periodic";
    type PresenceEvent = {
      type: string;
      event?: string;
      payload?: { presence: SystemPresence[] };
    };
    const beacon = async (overrides: { ip?: string; lastInputSeconds?: number }) => {
      const { ip, lastInputSeconds } = { ip: "10.0.0.9", lastInputSeconds: 7, ...overrides };
      const eventP = onceMessage<PresenceEvent>(
        ws,
        (frame) =>
          frame.type === "event" &&
          frame.event === "presence" &&
          (frame.payload?.presence.some(
            (row) =>
              row.instanceId === instanceId &&
              row.ip === ip &&
              row.lastInputSeconds === lastInputSeconds,
          ) ??
            false),
      );
      const [response, event] = await Promise.all([
        rpcReq(ws, "system-event", { text, instanceId, sessionKey, ...overrides }),
        eventP,
      ]);
      expect(response).toMatchObject({ ok: true, payload: { ok: true } });
      const rows = event.payload?.presence.filter((row) => row.instanceId === instanceId);
      expect(rows).toHaveLength(1);
    };

    try {
      await beacon({});
      expect(drainSystemEvents(sessionKey)).toEqual([
        "Node: Relay-Host (10.0.0.9) · app 2.1.0 · mode ui",
      ]);

      // Consuming the first event clears queue dedupe; it cannot hide a noisy refresh.
      await beacon({ lastInputSeconds: 11 });
      expect(drainSystemEvents(sessionKey)).toEqual([]);

      await beacon({ ip: "10.0.0.10", lastInputSeconds: 11 });
      expect(drainSystemEvents(sessionKey)).toEqual(["Node: Relay-Host (10.0.0.10)"]);
    } finally {
      drainSystemEvents(sessionKey);
      ws.close();
    }
  },
);
