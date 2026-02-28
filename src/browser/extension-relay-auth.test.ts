import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  probeAuthenticatedOpenClawRelay,
  resolveRelayAcceptedTokensForPort,
  resolveRelayAuthTokenForPort,
} from "./extension-relay-auth.js";
import { getFreePort } from "./test-port.js";

async function withRelayServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (params: { port: number }) => Promise<void>,
) {
  const port = await getFreePort();
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  try {
    const actualPort = (server.address() as AddressInfo).port;
    await run({ port: actualPort });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("extension-relay-auth", () => {
  const TEST_GATEWAY_TOKEN = "test-gateway-token";
  let prevGatewayToken: string | undefined;

  beforeEach(() => {
    prevGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = TEST_GATEWAY_TOKEN;
  });

  afterEach(() => {
    if (prevGatewayToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = prevGatewayToken;
    }
  });

  it("derives deterministic relay tokens per port", () => {
    const tokenA1 = resolveRelayAuthTokenForPort(18790);
    const tokenA2 = resolveRelayAuthTokenForPort(18790);
    const tokenB = resolveRelayAuthTokenForPort(18791);
    expect(tokenA1).toBe(tokenA2);
    expect(tokenA1).not.toBe(tokenB);
    expect(tokenA1).not.toBe(TEST_GATEWAY_TOKEN);
  });

  it("accepts both relay-scoped and raw gateway tokens for compatibility", () => {
    const tokens = resolveRelayAcceptedTokensForPort(18790);
    expect(tokens).toContain(TEST_GATEWAY_TOKEN);
    expect(tokens[0]).not.toBe(TEST_GATEWAY_TOKEN);
    expect(tokens[0]).toBe(resolveRelayAuthTokenForPort(18790));
  });

  it("accepts authenticated openclaw relay probe responses", async () => {
    let seenToken: string | undefined;
    await withRelayServer(
      (req, res) => {
        if (!req.url?.startsWith("/json/version")) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        const header = req.headers["x-openclaw-relay-token"];
        seenToken = Array.isArray(header) ? header[0] : header;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ Browser: "OpenClaw/extension-relay" }));
      },
      async ({ port }) => {
        const token = resolveRelayAuthTokenForPort(port);
        const ok = await probeAuthenticatedOpenClawRelay({
          baseUrl: `http://127.0.0.1:${port}`,
          relayAuthHeader: "x-openclaw-relay-token",
          relayAuthToken: token,
        });
        expect(ok).toBe(true);
        expect(seenToken).toBe(token);
      },
    );
  });

  it("rejects unauthenticated probe responses", async () => {
    await withRelayServer(
      (req, res) => {
        if (!req.url?.startsWith("/json/version")) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        res.writeHead(401);
        res.end("Unauthorized");
      },
      async ({ port }) => {
        const ok = await probeAuthenticatedOpenClawRelay({
          baseUrl: `http://127.0.0.1:${port}`,
          relayAuthHeader: "x-openclaw-relay-token",
          relayAuthToken: "irrelevant",
        });
        expect(ok).toBe(false);
      },
    );
  });

  it("rejects probe responses with wrong browser identity", async () => {
    await withRelayServer(
      (req, res) => {
        if (!req.url?.startsWith("/json/version")) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ Browser: "FakeRelay" }));
      },
      async ({ port }) => {
        const ok = await probeAuthenticatedOpenClawRelay({
          baseUrl: `http://127.0.0.1:${port}`,
          relayAuthHeader: "x-openclaw-relay-token",
          relayAuthToken: "irrelevant",
        });
        expect(ok).toBe(false);
      },
    );
  });
});
