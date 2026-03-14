import http from "node:http";
import https from "node:https";
import type {
  QuantdHeartbeatEvent,
  QuantdIngestResult,
  QuantdMarketEvent,
  QuantdOrderEvent,
  QuantdSnapshot,
} from "./types.js";

export const DEFAULT_QUANTD_BASE_URL = "http://127.0.0.1:19891";

type QuantdRequestResult = {
  status: number;
  body: string;
};

function requestQuantd(params: {
  baseUrl?: string;
  socketPath?: string;
  path: string;
  method?: string;
  body?: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<QuantdRequestResult> {
  const method = params.method ?? "GET";
  const timeoutMs = params.timeoutMs ?? 5_000;
  const rawBody = params.body ? JSON.stringify(params.body) : undefined;

  return new Promise((resolve, reject) => {
    const url = new URL(params.baseUrl ?? DEFAULT_QUANTD_BASE_URL);
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(
      {
        protocol: params.socketPath ? "http:" : url.protocol,
        hostname: params.socketPath ? undefined : url.hostname,
        port: params.socketPath ? undefined : url.port,
        socketPath: params.socketPath,
        path: params.path,
        method,
        headers: rawBody
          ? {
              "Content-Type": "application/json; charset=utf-8",
              "Content-Length": Buffer.byteLength(rawBody),
            }
          : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 500,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`quantd request timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    if (rawBody) {
      req.write(rawBody);
    }
    req.end();
  });
}

function parseJsonResponse<T>(result: QuantdRequestResult): T {
  if (result.status >= 400) {
    throw new Error(result.body || `quantd request failed with status ${result.status}`);
  }
  return JSON.parse(result.body) as T;
}

export function createQuantdClient(options?: {
  baseUrl?: string;
  socketPath?: string;
  timeoutMs?: number;
}) {
  const baseUrl = options?.baseUrl ?? DEFAULT_QUANTD_BASE_URL;
  const socketPath = options?.socketPath;
  const timeoutMs = options?.timeoutMs;

  return {
    async health(): Promise<{ ok: boolean; status: number; body: string }> {
      const result = await requestQuantd({
        baseUrl,
        socketPath,
        path: "/healthz",
        timeoutMs,
      });
      return {
        ok: result.status < 400,
        status: result.status,
        body: result.body,
      };
    },

    async snapshot(): Promise<QuantdSnapshot> {
      const result = await requestQuantd({
        baseUrl,
        socketPath,
        path: "/v1/snapshot",
        timeoutMs,
      });
      return parseJsonResponse<QuantdSnapshot>(result);
    },

    async ingestHeartbeat(event: QuantdHeartbeatEvent): Promise<QuantdIngestResult> {
      const result = await requestQuantd({
        baseUrl,
        socketPath,
        path: "/v1/heartbeat",
        method: "POST",
        body: event,
        timeoutMs,
      });
      return parseJsonResponse<QuantdIngestResult>(result);
    },

    async ingestMarketEvent(event: QuantdMarketEvent): Promise<QuantdIngestResult> {
      const result = await requestQuantd({
        baseUrl,
        socketPath,
        path: "/v1/market-events",
        method: "POST",
        body: event,
        timeoutMs,
      });
      return parseJsonResponse<QuantdIngestResult>(result);
    },

    async ingestOrderEvent(event: QuantdOrderEvent): Promise<QuantdIngestResult> {
      const result = await requestQuantd({
        baseUrl,
        socketPath,
        path: "/v1/order-events",
        method: "POST",
        body: event,
        timeoutMs,
      });
      return parseJsonResponse<QuantdIngestResult>(result);
    },
  };
}
