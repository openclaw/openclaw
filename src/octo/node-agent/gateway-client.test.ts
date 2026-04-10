// Octopus Orchestrator -- NodeAgentGatewayClient tests (M4-04)
//
// Unit tests using a mock GatewayTransport. No real WebSocket needed.
//
// Coverage:
//   1. connect sends caps.octo with version + adapters
//   2. sendLeaseRenew formats payload per OctoLeaseRenewPushSchema
//   3. dispatchIncoming routes spawn/terminate/reconcile to handlers
//   4. disconnect closes the transport
//   5. error paths (double connect, send before connect, empty leases)

import { describe, expect, it, vi } from "vitest";
import type { ConnectParams, GatewayTransport, LeaseEntry } from "./gateway-client.ts";
import { NodeAgentGatewayClient } from "./gateway-client.ts";

// ──────────────────────────────────────────────────────────────────────────
// Mock transport
// ──────────────────────────────────────────────────────────────────────────

interface MockTransport extends GatewayTransport {
  lastConnectParams: ConnectParams | null;
  lastSendMethod: string | null;
  lastSendPayload: unknown;
  pushHandler: ((event: string, data: unknown) => void) | null;
  closed: boolean;
}

function createMockTransport(): MockTransport {
  const mock: MockTransport = {
    lastConnectParams: null,
    lastSendMethod: null,
    lastSendPayload: null,
    pushHandler: null,
    closed: false,

    async connect(params: ConnectParams): Promise<void> {
      mock.lastConnectParams = params;
    },

    async send(method: string, payload: unknown): Promise<unknown> {
      mock.lastSendMethod = method;
      mock.lastSendPayload = payload;
      return { ok: true };
    },

    onPush(handler: (event: string, data: unknown) => void): void {
      mock.pushHandler = handler;
    },

    async close(): Promise<void> {
      mock.closed = true;
    },
  };
  return mock;
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe("NodeAgentGatewayClient", () => {
  const NODE_ID = "node-test-001";
  const CAPABILITIES = ["octo"];
  const ADAPTERS = ["structured_subagent", "cli_exec", "pty_tmux"];

  function makeClient(transport: GatewayTransport): NodeAgentGatewayClient {
    return new NodeAgentGatewayClient(transport, NODE_ID, CAPABILITIES, ADAPTERS);
  }

  // ── connect ──────────────────────────────────────────────────────────

  describe("connect", () => {
    it("sends connect frame with role:node and caps.octo", async () => {
      const transport = createMockTransport();
      const client = makeClient(transport);

      await client.connect();

      expect(transport.lastConnectParams).not.toBeNull();
      const params = transport.lastConnectParams!;
      expect(params.role).toBe("node");
      expect(params.deviceId).toBe(NODE_ID);
      expect(params.caps).toEqual({
        octo: {
          version: "1",
          adapters: ADAPTERS,
        },
      });
      expect(params.commands).toContain("octo.arm.spawn");
      expect(params.commands).toContain("octo.arm.terminate");
      expect(params.commands).toContain("octo.node.reconcile");
      expect(params.commands).toContain("octo.node.capabilities");
      expect(client.isConnected()).toBe(true);
    });

    it("registers push handler on transport", async () => {
      const transport = createMockTransport();
      const client = makeClient(transport);

      await client.connect();

      expect(transport.pushHandler).not.toBeNull();
    });

    it("throws on double connect", async () => {
      const transport = createMockTransport();
      const client = makeClient(transport);

      await client.connect();
      await expect(client.connect()).rejects.toThrow("already connected");
    });
  });

  // ── sendLeaseRenew ───────────────────────────────────────────────────

  describe("sendLeaseRenew", () => {
    it("formats payload matching OctoLeaseRenewPushSchema", async () => {
      const transport = createMockTransport();
      const client = makeClient(transport);
      await client.connect();

      const leases: LeaseEntry[] = [
        { arm_id: "arm-001", lease_expiry_ts: "2026-04-09T12:00:00.000Z" },
        { arm_id: "arm-002", lease_expiry_ts: "2026-04-09T12:05:00.000Z" },
      ];

      await client.sendLeaseRenew(leases);

      expect(transport.lastSendMethod).toBe("octo.lease.renew");
      const payload = transport.lastSendPayload as Record<string, unknown>;
      expect(payload.node_id).toBe(NODE_ID);
      expect(typeof payload.ts).toBe("string");
      expect(payload.leases).toEqual(leases);
    });

    it("throws when not connected", async () => {
      const transport = createMockTransport();
      const client = makeClient(transport);

      await expect(
        client.sendLeaseRenew([{ arm_id: "arm-001", lease_expiry_ts: "2026-04-09T12:00:00Z" }]),
      ).rejects.toThrow("not connected");
    });

    it("throws on empty leases array", async () => {
      const transport = createMockTransport();
      const client = makeClient(transport);
      await client.connect();

      await expect(client.sendLeaseRenew([])).rejects.toThrow("leases must not be empty");
    });
  });

  // ── dispatchIncoming ─────────────────────────────────────────────────

  describe("dispatchIncoming", () => {
    it("routes octo.arm.spawn to registered handler", async () => {
      const transport = createMockTransport();
      const client = makeClient(transport);
      await client.connect();

      const spawnHandler = vi.fn().mockResolvedValue({ session_ref: "sess-001" });
      client.onMethod("octo.arm.spawn", spawnHandler);

      const result = await client.dispatchIncoming("octo.arm.spawn", {
        arm_spec: { adapter: "cli_exec" },
      });

      expect(spawnHandler).toHaveBeenCalledWith({ arm_spec: { adapter: "cli_exec" } });
      expect(result).toEqual({ session_ref: "sess-001" });
    });

    it("routes octo.arm.terminate to registered handler", async () => {
      const transport = createMockTransport();
      const client = makeClient(transport);
      await client.connect();

      const terminateHandler = vi.fn().mockResolvedValue({ ok: true });
      client.onMethod("octo.arm.terminate", terminateHandler);

      const result = await client.dispatchIncoming("octo.arm.terminate", {
        arm_id: "arm-001",
        reason: "operator_request",
      });

      expect(terminateHandler).toHaveBeenCalledWith({
        arm_id: "arm-001",
        reason: "operator_request",
      });
      expect(result).toEqual({ ok: true });
    });

    it("routes octo.node.reconcile to registered handler", async () => {
      const transport = createMockTransport();
      const client = makeClient(transport);
      await client.connect();

      const reconcileHandler = vi.fn().mockResolvedValue({ reconciled: 3 });
      client.onMethod("octo.node.reconcile", reconcileHandler);

      const result = await client.dispatchIncoming("octo.node.reconcile", {
        idempotency_key: "idem-001",
      });

      expect(reconcileHandler).toHaveBeenCalledWith({ idempotency_key: "idem-001" });
      expect(result).toEqual({ reconciled: 3 });
    });

    it("throws for unregistered method", async () => {
      const transport = createMockTransport();
      const client = makeClient(transport);
      await client.connect();

      await expect(client.dispatchIncoming("octo.unknown.method", {})).rejects.toThrow(
        'no handler for method "octo.unknown.method"',
      );
    });
  });

  // ── disconnect ───────────────────────────────────────────────────────

  describe("disconnect", () => {
    it("closes transport and marks as disconnected", async () => {
      const transport = createMockTransport();
      const client = makeClient(transport);
      await client.connect();

      await client.disconnect();

      expect(transport.closed).toBe(true);
      expect(client.isConnected()).toBe(false);
    });

    it("is idempotent when not connected", async () => {
      const transport = createMockTransport();
      const client = makeClient(transport);

      await client.disconnect(); // Should not throw
      expect(transport.closed).toBe(false);
    });
  });

  // ── push routing via transport ─────────────────────────────────────

  describe("push routing", () => {
    it("routes pushes from transport to registered handlers", async () => {
      const transport = createMockTransport();
      const client = makeClient(transport);

      const capHandler = vi.fn().mockResolvedValue({ caps: [] });
      client.onMethod("octo.node.capabilities", capHandler);

      await client.connect();

      // Simulate an incoming push from the transport
      transport.pushHandler!("octo.node.capabilities", { query: true });

      // Give the void promise a tick to resolve
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(capHandler).toHaveBeenCalledWith({ query: true });
    });
  });
});
