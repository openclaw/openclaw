import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { STATE_DIR } from "../config/paths.js";
import { readJsonBodyWithLimit } from "../infra/http-body.js";
import { createQuantdStateStore } from "./state.js";
import type {
  QuantdEventKind,
  QuantdEventPayload,
  QuantdHeartbeatEvent,
  QuantdIngestResult,
  QuantdMarketEvent,
  QuantdOrderEvent,
  QuantdSnapshot,
} from "./types.js";
import { appendQuantdWalRecord, readQuantdWalRecords } from "./wal.js";

const DEFAULT_QUANTD_MAX_BODY_BYTES = 256 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toEventPayload<T extends QuantdEventPayload>(value: unknown): T {
  if (!isRecord(value)) {
    throw new Error("request body must be a JSON object");
  }
  return value as T;
}

function sendJson(res: ServerResponse, status: number, value: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value));
}

function sendText(res: ServerResponse, status: number, value: string) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(value);
}

async function listenQuantdServer(params: {
  server: ReturnType<typeof createServer>;
  host: string;
  port: number;
  socketPath?: string;
}) {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      params.server.off("error", onError);
      reject(error);
    };
    params.server.once("error", onError);
    if (params.socketPath) {
      params.server.listen(params.socketPath, () => {
        params.server.off("error", onError);
        resolve();
      });
      return;
    }
    params.server.listen(params.port, params.host, () => {
      params.server.off("error", onError);
      resolve();
    });
  });
}

async function ingestEvent(params: {
  kind: QuantdEventKind;
  body: unknown;
  walPath: string;
  store: ReturnType<typeof createQuantdStateStore>;
}): Promise<QuantdIngestResult> {
  const payload = toEventPayload<QuantdEventPayload>(params.body);
  const prepared = params.store.prepareEvent(params.kind, payload);
  if (prepared.duplicate) {
    return {
      ok: true,
      applied: false,
      replayed: true,
      sequence: prepared.existingSequence,
      kind: params.kind,
    };
  }

  await appendQuantdWalRecord({
    walPath: params.walPath,
    record: prepared.record,
  });
  params.store.commitRecord(prepared.record);
  return {
    ok: true,
    applied: true,
    replayed: false,
    sequence: prepared.record.sequence,
    kind: params.kind,
  };
}

export function resolveQuantdWalPath(input?: string): string {
  const trimmed = input?.trim();
  if (trimmed) {
    return trimmed;
  }
  return path.join(STATE_DIR, "quantd", "events.jsonl");
}

export async function startQuantdServer(options?: {
  host?: string;
  port?: number;
  socketPath?: string;
  walPath?: string;
  heartbeatStaleAfterMs?: number;
  recentEventLimit?: number;
  bodyLimitBytes?: number;
  now?: () => number;
}) {
  const host = options?.host ?? "127.0.0.1";
  const port = options?.port ?? 19_891;
  const socketPath = options?.socketPath?.trim() || undefined;
  const walPath = resolveQuantdWalPath(options?.walPath);
  const store = createQuantdStateStore({
    walPath,
    heartbeatStaleAfterMs: options?.heartbeatStaleAfterMs,
    recentEventLimit: options?.recentEventLimit,
    now: options?.now,
  });

  const replayRecords = await readQuantdWalRecords({ walPath });
  for (const record of replayRecords) {
    store.commitRecord(record, { fromReplay: true });
  }

  if (socketPath) {
    await fs.mkdir(path.dirname(socketPath), { recursive: true });
    await fs.rm(socketPath, { force: true });
  }

  const server = createServer((req, res) => {
    const route = `${req.method ?? "GET"} ${req.url ?? "/"}`;
    const bodyLimitBytes = options?.bodyLimitBytes ?? DEFAULT_QUANTD_MAX_BODY_BYTES;
    if (route === "GET /healthz") {
      const snapshot = store.snapshot();
      const statusCode = snapshot.health.status === "ok" ? 200 : 503;
      sendText(res, statusCode, snapshot.health.status === "ok" ? "ok" : "degraded");
      return;
    }
    if (route === "GET /v1/snapshot") {
      sendJson(res, 200, store.snapshot());
      return;
    }
    if (
      route === "POST /v1/heartbeat" ||
      route === "POST /v1/market-events" ||
      route === "POST /v1/order-events"
    ) {
      void (async () => {
        const parsed = await readJsonBodyWithLimit(req, {
          maxBytes: bodyLimitBytes,
          emptyObjectOnEmpty: false,
        });
        if (!parsed.ok) {
          const status =
            parsed.code === "PAYLOAD_TOO_LARGE"
              ? 413
              : parsed.code === "REQUEST_BODY_TIMEOUT"
                ? 408
                : 400;
          sendJson(res, status, {
            error: parsed.error,
          });
          return;
        }
        try {
          const result =
            route === "POST /v1/heartbeat"
              ? await ingestEvent({
                  kind: "heartbeat",
                  body: parsed.value as QuantdHeartbeatEvent,
                  walPath,
                  store,
                })
              : route === "POST /v1/market-events"
                ? await ingestEvent({
                    kind: "market_event",
                    body: parsed.value as QuantdMarketEvent,
                    walPath,
                    store,
                  })
                : await ingestEvent({
                    kind: "order_event",
                    body: parsed.value as QuantdOrderEvent,
                    walPath,
                    store,
                  });
          sendJson(res, 200, result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, /json object/i.test(message) ? 400 : 500, {
            error: message,
          });
        }
      })();
      return;
    }
    sendText(res, 404, "not found");
  });

  await listenQuantdServer({
    server,
    host,
    port,
    socketPath,
  });

  const address = server.address();
  const baseUrl =
    socketPath || !address || typeof address === "string"
      ? undefined
      : `http://${host}:${address.port}`;

  return {
    baseUrl,
    socketPath,
    walPath,
    snapshot(): QuantdSnapshot {
      return store.snapshot();
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      if (socketPath) {
        await fs.rm(socketPath, { force: true });
      }
    },
  };
}
