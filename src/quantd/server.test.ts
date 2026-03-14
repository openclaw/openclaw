import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createQuantdClient } from "./client.js";
import { startQuantdServer } from "./server.js";

describe("quantd server", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupPaths.splice(0).map(async (target) => {
        await fs.rm(target, { recursive: true, force: true });
      }),
    );
  });

  it("writes events, returns snapshot, and replays WAL on restart", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-quantd-server-"));
    cleanupPaths.push(root);
    const walPath = path.join(root, "quantd.jsonl");

    const started = await startQuantdServer({
      host: "127.0.0.1",
      port: 0,
      walPath,
      heartbeatStaleAfterMs: 10_000,
    });

    const client = createQuantdClient({
      baseUrl: started.baseUrl,
    });

    await expect(
      client.ingestHeartbeat({
        eventId: "hb-1",
        source: "gateway",
      }),
    ).resolves.toMatchObject({
      ok: true,
      applied: true,
      replayed: false,
      sequence: 1,
    });

    await expect(
      client.ingestMarketEvent({
        eventId: "mkt-1",
        symbol: "EURUSD",
        signal: "enter_long",
      }),
    ).resolves.toMatchObject({
      ok: true,
      applied: true,
      replayed: false,
      sequence: 2,
    });

    await expect(
      client.ingestMarketEvent({
        eventId: "mkt-1",
        symbol: "EURUSD",
        signal: "enter_long",
      }),
    ).resolves.toMatchObject({
      ok: true,
      applied: false,
      replayed: true,
      sequence: 2,
    });

    await expect(client.snapshot()).resolves.toMatchObject({
      health: {
        status: "ok",
      },
      wal: {
        path: walPath,
        records: 2,
      },
      metrics: {
        heartbeats: 1,
        marketEvents: 1,
        duplicateEvents: 1,
      },
      replay: {
        lastSequence: 2,
      },
    });

    await started.close();

    const restarted = await startQuantdServer({
      host: "127.0.0.1",
      port: 0,
      walPath,
      heartbeatStaleAfterMs: 10_000,
    });

    const restartedClient = createQuantdClient({
      baseUrl: restarted.baseUrl,
    });

    await expect(restartedClient.snapshot()).resolves.toMatchObject({
      wal: {
        records: 2,
      },
      replay: {
        lastSequence: 2,
        replayedRecords: 2,
      },
      metrics: {
        heartbeats: 1,
        marketEvents: 1,
      },
    });

    await restarted.close();
  });

  it("rejects non-object JSON bodies for event ingestion", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-quantd-server-invalid-"));
    cleanupPaths.push(root);
    const walPath = path.join(root, "quantd.jsonl");
    const started = await startQuantdServer({
      host: "127.0.0.1",
      port: 0,
      walPath,
    });

    const baseUrl = started.baseUrl ?? "";

    await expect(
      fetch(`${baseUrl}/v1/market-events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "[]",
      }).then(async (res) => ({ status: res.status, body: await res.json() })),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "request body must be a JSON object" },
    });

    await expect(
      fetch(`${baseUrl}/v1/order-events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '"x"',
      }).then(async (res) => ({ status: res.status, body: await res.json() })),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "request body must be a JSON object" },
    });

    await expect(
      fetch(`${baseUrl}/v1/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "123",
      }).then(async (res) => ({ status: res.status, body: await res.json() })),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: "request body must be a JSON object" },
    });

    await started.close();
  });
});
