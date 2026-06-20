import { describe, expect, it } from "vitest";
import {
  createPostgresSessionAdmissionController,
  type SessionStoreBackpressureSnapshot,
} from "./postgres-admission.js";
import type {
  PostgresSessionStoreQueryClient,
  PostgresSessionStoreQueryResult,
  PostgresSessionStoreQueryRow,
} from "./postgres-store-adapter.js";

type QueryCall = { sql: string; values?: readonly unknown[] };
type QueryResponse = PostgresSessionStoreQueryResult<Record<string, unknown>>;

function createFakeClient(responses: QueryResponse[] = []) {
  const calls: QueryCall[] = [];
  const client: PostgresSessionStoreQueryClient = {
    async query<TRow extends PostgresSessionStoreQueryRow = PostgresSessionStoreQueryRow>(
      sql: string,
      values?: readonly unknown[],
    ): Promise<PostgresSessionStoreQueryResult<TRow>> {
      calls.push(values ? { sql, values } : { sql });
      return (responses.shift() ?? {
        rows: [],
        rowCount: 0,
      }) as PostgresSessionStoreQueryResult<TRow>;
    },
  };
  return { client, calls };
}

const empty = { rows: [], rowCount: 0 };

function controllerFor(client: PostgresSessionStoreQueryClient) {
  return createPostgresSessionAdmissionController(client, {
    tenantId: "type0",
    gatewayId: "type0-producer",
    schema: "type0_sessions",
  });
}

describe("Postgres session admission controller", () => {
  it("acquires leases atomically when absent, expired, or held by the same holder", async () => {
    const { client, calls } = createFakeClient([
      empty,
      empty,
      {
        rows: [
          {
            lease_key: "campaign:c7",
            holder_id: "operator",
            expires_at: "2026-05-26T08:00:00.000Z",
          },
        ],
        rowCount: 1,
      },
    ]);

    await expect(
      controllerFor(client).tryAcquireLease({
        leaseKey: "campaign:c7",
        holderId: "operator",
        ttlMs: 5_000,
        metadata: { reason: "test" },
      }),
    ).resolves.toEqual({
      acquired: true,
      leaseKey: "campaign:c7",
      holderId: "operator",
      expiresAt: "2026-05-26T08:00:00.000Z",
    });

    expect(calls[2]?.sql).toContain('INSERT INTO "type0_sessions"."openclaw_session_leases"');
    expect(calls[2]?.sql).toContain("ON CONFLICT (tenant_id, gateway_id, lease_key)");
    expect(calls[2]?.sql).toContain("expires_at <= now()");
    expect(calls[2]?.values).toEqual([
      "type0",
      "type0-producer",
      "campaign:c7",
      "operator",
      "5000 milliseconds",
      JSON.stringify({ reason: "test" }),
    ]);
  });

  it("denies leases held by another unexpired holder", async () => {
    const { client, calls } = createFakeClient([
      empty,
      empty,
      empty,
      {
        rows: [{ holder_id: "other", expires_at: "2026-05-26T09:00:00.000Z" }],
        rowCount: 1,
      },
    ]);

    await expect(
      controllerFor(client).tryAcquireLease({
        leaseKey: "campaign:c7",
        holderId: "operator",
        ttlMs: 5_000,
      }),
    ).resolves.toEqual({
      acquired: false,
      leaseKey: "campaign:c7",
      holderId: "other",
      expiresAt: "2026-05-26T09:00:00.000Z",
      reason: "held",
    });

    expect(calls[3]?.sql).toContain("SELECT lease_key, holder_id, expires_at");
  });

  it("admits lanes under max-running and records denial before overload", async () => {
    const admittedSnapshot: SessionStoreBackpressureSnapshot = {
      lane: "type0-producer",
      admitted: 3,
      running: 2,
      queued: 0,
      rejected: 0,
      maxRunning: 2,
      maxQueued: 10,
    };
    const deniedSnapshot: SessionStoreBackpressureSnapshot = {
      lane: "type0-producer",
      admitted: 3,
      running: 2,
      queued: 0,
      rejected: 1,
      maxRunning: 2,
      maxQueued: 10,
    };
    const { client, calls } = createFakeClient([
      empty,
      empty,
      empty,
      {
        rows: [
          {
            lane: "type0-producer",
            admitted: 3,
            running: 2,
            queued: 0,
            rejected: 0,
            max_running: 2,
            max_queued: 10,
          },
        ],
        rowCount: 1,
      },
      empty,
      empty,
      empty,
      empty,
      {
        rows: [
          {
            lane: "type0-producer",
            admitted: 3,
            running: 2,
            queued: 0,
            rejected: 1,
            max_running: 2,
            max_queued: 10,
          },
        ],
        rowCount: 1,
      },
    ]);
    const controller = controllerFor(client);

    await expect(
      controller.admitLane({
        lane: "type0-producer",
        runningCost: 1,
        maxRunning: 2,
        maxQueued: 10,
      }),
    ).resolves.toEqual({ admitted: true, snapshot: admittedSnapshot });
    await expect(
      controller.admitLane({
        lane: "type0-producer",
        runningCost: 1,
        maxRunning: 2,
        maxQueued: 10,
      }),
    ).resolves.toEqual({ admitted: false, reason: "max_running", snapshot: deniedSnapshot });

    expect(calls[3]?.sql).toContain("running + $4 <= $5");
    expect(calls[3]?.values).toEqual(["type0", "type0-producer", "type0-producer", 1, 2]);
    expect(calls[8]?.sql).toContain("rejected = rejected + 1");
  });

  it("records gateway event-loop health and releases lease/lane counters", async () => {
    const { client, calls } = createFakeClient([
      empty,
      empty,
      { rows: [], rowCount: 1 },
      {
        rows: [{ lane: "type0-producer", admitted: 1, running: 0, queued: 0, rejected: 0 }],
        rowCount: 1,
      },
    ]);
    const controller = controllerFor(client);

    await controller.recordGatewayHealth({
      processId: 123,
      eventLoopLagMs: 42,
      configPath: "/cfg/openclaw.json",
      stateDir: "/state/type0",
      sessionDir: "/state/type0/sessions",
    });
    await expect(
      controller.releaseLease({ leaseKey: "campaign:c7", holderId: "operator" }),
    ).resolves.toBe(true);
    await expect(
      controller.releaseLaneRun({ lane: "type0-producer", runningCost: 1 }),
    ).resolves.toEqual({
      lane: "type0-producer",
      admitted: 1,
      running: 0,
      queued: 0,
      rejected: 0,
    });

    expect(calls[1]?.values).toEqual([
      "type0",
      "type0-producer",
      "/cfg/openclaw.json",
      "/state/type0",
      "/state/type0/sessions",
      123,
      42,
    ]);
    expect(calls[2]?.sql).toContain("DELETE FROM");
    expect(calls[3]?.sql).toContain("GREATEST(0, running - $4)");
  });
});
