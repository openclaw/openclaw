import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAppFolioExecuteAdapterFromEnv,
  type AppFolioExecuteIntentRequest,
} from "./appfolio-adapter.js";

const originalExecuteUrl = process.env.OPENCLAW_APPFOLIO_EXECUTE_URL;
const originalExecuteToken = process.env.OPENCLAW_APPFOLIO_EXECUTE_TOKEN;

afterEach(() => {
  if (originalExecuteUrl === undefined) {
    delete process.env.OPENCLAW_APPFOLIO_EXECUTE_URL;
  } else {
    process.env.OPENCLAW_APPFOLIO_EXECUTE_URL = originalExecuteUrl;
  }
  if (originalExecuteToken === undefined) {
    delete process.env.OPENCLAW_APPFOLIO_EXECUTE_TOKEN;
  } else {
    process.env.OPENCLAW_APPFOLIO_EXECUTE_TOKEN = originalExecuteToken;
  }
});

function buildRequest(): AppFolioExecuteIntentRequest {
  return {
    requestId: "req-1",
    intentSlug: "current_balance",
    unitId: "402",
    propertyId: "AZ-1",
    messageText: "What is my balance?",
    args: { includeAging: true },
  };
}

describe("appfolio-adapter", () => {
  it("returns not-configured error when execute URL is missing", async () => {
    delete process.env.OPENCLAW_APPFOLIO_EXECUTE_URL;
    const execute = createAppFolioExecuteAdapterFromEnv();

    const result = await execute(buildRequest());
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("api_adapter_not_configured");
  });

  it("sends the expected request contract and maps successful response", async () => {
    let receivedBody: unknown = null;
    let receivedAuth: string | undefined;

    const server = createServer((req, res) => {
      receivedAuth = req.headers.authorization;
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        receivedBody = JSON.parse(raw);
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, data: { currentBalance: 315.22 } }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    process.env.OPENCLAW_APPFOLIO_EXECUTE_URL = `http://127.0.0.1:${port}/execute`;
    process.env.OPENCLAW_APPFOLIO_EXECUTE_TOKEN = "token-123";

    try {
      const execute = createAppFolioExecuteAdapterFromEnv();
      const result = await execute(buildRequest());
      expect(result.ok).toBe(true);
      expect(result.data).toEqual({ currentBalance: 315.22 });
      expect(receivedAuth).toBe("Bearer token-123");
      expect(receivedBody).toMatchObject({
        requestId: "req-1",
        intentSlug: "current_balance",
        unitId: "402",
        propertyId: "AZ-1",
        messageText: "What is my balance?",
        args: { includeAging: true },
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("maps 5xx responses to retriable adapter failures", async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "unavailable" }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    process.env.OPENCLAW_APPFOLIO_EXECUTE_URL = `http://127.0.0.1:${port}/execute`;

    try {
      const execute = createAppFolioExecuteAdapterFromEnv();
      const result = await execute(buildRequest());
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("api_http_503");
      expect(result.retriable).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  const maybeLive = process.env.OPENCLAW_APPFOLIO_CONTRACT_LIVE === "1" ? it : it.skip;
  maybeLive("probes live FastAPI adapter contract when explicitly enabled", async () => {
    const execute = createAppFolioExecuteAdapterFromEnv();
    const result = await execute(buildRequest());

    expect(typeof result.ok).toBe("boolean");
    expect(typeof result.sourceLatencyMs).toBe("number");
    if (result.ok) {
      expect(typeof result.data).toBe("object");
    } else {
      expect(typeof result.errorCode).toBe("string");
    }
  });
});