/** Gateway health endpoint integration tests. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { asOptionalRecord, expectDefined } from "@openclaw/normalization-core";
import { expect, test, vi } from "vitest";
import { readGatewayMemory } from "../../scripts/lib/gateway-bench-probes.js";
import { writeConfigFile } from "../config/config.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { drainSystemEvents } from "../infra/system-events.js";
import type { SystemPresence } from "../infra/system-presence.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { installGatewayTestHooks, onceMessage, rpcReq } from "./test-helpers.js";

// Health/presence coverage does not exercise post-restart delivery recovery.
// Keep that auto-reply graph in the dedicated restart-sentinel suite.
vi.mock("./server-restart-sentinel.js", () => ({
  recoverPendingRestartContinuationDeliveries: vi.fn(async () => undefined),
}));

const healthTimeout = { timeout: 20_000 };
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

test("connect + health + presence + status succeed", healthTimeout, async () => {
  const { ws } = await harness.openClient();

  let statusPayload: Record<string, unknown> | undefined;
  const statusP = readGatewayMemory(
    async <T>(method: string, params: unknown, timeoutMs?: number) => {
      const response = await rpcReq<T & Record<string, unknown>>(ws, method, params, timeoutMs);
      expect(response.ok).toBe(true);
      const payload = expectDefined(response.payload, "status response payload");
      statusPayload = payload;
      return payload;
    },
    performance.now(),
  );
  const [health, sample, presence] = await Promise.all([
    rpcReq(ws, "health", {}),
    statusP,
    rpcReq(ws, "system-presence", {}),
  ]);
  expect([health.ok, presence.ok]).toEqual([true, true]);
  expect(Array.isArray(presence.payload)).toBe(true);
  const memory = expectDefined(
    asOptionalRecord(statusPayload?.processMemory),
    "status process memory",
  );
  for (const [field, megabytes] of Object.entries({
    rssBytes: sample.rssMb,
    heapUsedBytes: sample.heapUsedMb,
    heapTotalBytes: sample.heapTotalMb,
    externalBytes: sample.externalMb,
    arrayBuffersBytes: sample.arrayBuffersMb,
  })) {
    const bytes = memory[field];
    assert(typeof bytes === "number", `Expected numeric process memory field: ${field}`);
    expect(Number.isFinite(bytes)).toBe(true);
    expect(bytes).toBeGreaterThanOrEqual(0);
    expect(megabytes).toBe(bytes / 1048576);
  }

  ws.close();
});

test("presence events carry seq + stateVersion", presenceTimeout, async () => {
  const { ws } = await harness.openClient();

  const presenceEventP = onceMessage<PresenceEvent>(
    ws,
    (o) => o.type === "event" && o.event === "presence",
  );
  const [, evt] = await Promise.all([
    rpcReq(ws, "system-event", { text: "note from test" }),
    presenceEventP,
  ]);
  expect(typeof evt.seq).toBe("number");
  expect(evt.stateVersion?.presence).toBeGreaterThan(0);
  expect(Array.isArray(evt.payload?.presence)).toBe(true);

  const instanceId = `presence-beacon-${randomUUID()}`;
  const sessionKey = `agent:main:presence-${randomUUID()}`;
  const text =
    "Node: Relay-Host (10.0.0.9) · app 2.1.0 · last input 7s ago · mode ui · reason periodic";
  type PresenceEvent = {
    type: string;
    event?: string;
    payload?: { presence: SystemPresence[] };
    seq?: number;
    stateVersion?: { presence?: number };
  };
  let seq = expectDefined(evt.seq, "presence sequence");
  let version = expectDefined(evt.stateVersion?.presence, "presence state version");
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
    expect(event.seq).toBeGreaterThan(seq);
    expect(event.stateVersion?.presence).toBeGreaterThan(version);
    seq = expectDefined(event.seq, "presence sequence");
    version = expectDefined(event.stateVersion?.presence, "presence state version");
    const rows = event.payload?.presence.filter((row) => row.instanceId === instanceId);
    expect(rows).toEqual([
      expect.objectContaining({
        host: "Relay-Host",
        ip,
        version: "2.1.0",
        lastInputSeconds,
        mode: "ui",
        reason: "periodic",
        instanceId,
        text,
        ts: expect.any(Number),
      }),
    ]);
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
});

test("agent events stream with seq", presenceTimeout, async () => {
  const { ws } = await harness.openClient();

  const runId = randomUUID();
  const evtPromise = onceMessage(
    ws,
    (o) =>
      o.type === "event" &&
      o.event === "agent" &&
      o.payload?.runId === runId &&
      o.payload?.stream === "lifecycle",
  );
  emitAgentEvent({ runId, stream: "lifecycle", data: { msg: "hi" } });
  const evt = await evtPromise;
  expect(evt).toMatchObject({ seq: expect.any(Number), payload: { runId, data: { msg: "hi" } } });

  ws.close();
});
