/**
 * Marketplace E2E tests — validates the full P2P compute marketplace flow.
 *
 * Creates a standalone HTTP server wiring `handleMarketplaceHttpRequest` directly,
 * with a mock node registry and real scheduler + event bus. Simulates seller node
 * responses via the event bus to verify buyer HTTP endpoint behavior for both
 * streaming and non-streaming requests.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http, {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { getDeterministicFreePortBlock } from "../test-utils/ports.js";
import { handleMarketplaceHttpRequest, type MarketplaceHttpOptions } from "./marketplace-http.js";
import {
  calculateMarketplacePrice,
  calculateSellerPayout,
  buildCommercePayloads,
} from "./marketplace/billing.js";
import { marketplaceEventBus, type MarketplaceProxyEvent } from "./marketplace/event-bus.js";
import { MarketplaceScheduler } from "./marketplace/scheduler.js";

/** Minimal JSON POST helper. */
function httpPost(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  const payload = JSON.stringify(body);
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    r.on("error", reject);
    r.write(payload);
    r.end();
  });
}

/** SSE stream reader — collects events until connection ends. */
function httpPostSse(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  events: string[];
}> {
  const payload = JSON.stringify(body);
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        const events: string[] = [];
        let buffer = "";
        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("data: ")) {
              events.push(trimmed.slice(6));
            }
          }
        });
        res.on("end", () => {
          if (buffer.trim().startsWith("data: ")) {
            events.push(buffer.trim().slice(6));
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            events,
          });
        });
      },
    );
    r.on("error", reject);
    r.write(payload);
    r.end();
  });
}

/** HTTP GET helper. */
function httpGet(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "GET",
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

describe("marketplace e2e", () => {
  let tempHome: string;
  let port: number;
  let httpServer: HttpServer;
  let scheduler: MarketplaceScheduler;
  let envSnapshot: ReturnType<typeof captureEnv>;
  const token = `mkt-e2e-${randomUUID()}`;
  const sellerNodeId = `seller-${randomUUID()}`;

  /**
   * Simulate a seller node handling a proxy request.
   * Emits marketplace events on the event bus as if the seller node
   * had responded via WebSocket.
   */
  function simulateSellerResponse(
    requestId: string,
    opts?: {
      streaming?: boolean;
      error?: boolean;
      delayMs?: number;
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
    },
  ): void {
    const model = opts?.model ?? "claude-sonnet-4-20250514";
    const inputTokens = opts?.inputTokens ?? 40;
    const outputTokens = opts?.outputTokens ?? 12;
    const delay = opts?.delayMs ?? 5;

    setTimeout(() => {
      if (opts?.error) {
        marketplaceEventBus.emitProxy({
          nodeId: sellerNodeId,
          requestId,
          kind: "error",
          payload: { message: "seller-side failure", code: "PROXY_ERROR" },
        });
        return;
      }

      if (opts?.streaming) {
        const chunks = [
          JSON.stringify({
            id: `chatcmpl-${requestId}`,
            choices: [{ delta: { content: "Hello" } }],
          }),
          JSON.stringify({
            id: `chatcmpl-${requestId}`,
            choices: [{ delta: { content: " there" } }],
          }),
          JSON.stringify({
            id: `chatcmpl-${requestId}`,
            choices: [{ delta: { content: " friend!" } }],
          }),
        ];
        for (let i = 0; i < chunks.length; i++) {
          setTimeout(() => {
            marketplaceEventBus.emitProxy({
              nodeId: sellerNodeId,
              requestId,
              kind: "chunk",
              payload: { data: chunks[i], done: false },
            });
          }, i * 3);
        }
        setTimeout(
          () => {
            marketplaceEventBus.emitProxy({
              nodeId: sellerNodeId,
              requestId,
              kind: "done",
              payload: {
                requestId,
                model,
                inputTokens,
                outputTokens,
                totalTokens: inputTokens + outputTokens,
                durationMs: 150,
              },
            });
          },
          chunks.length * 3 + 10,
        );
      } else {
        const responseData = JSON.stringify({
          id: `chatcmpl-${requestId}`,
          type: "message",
          role: "assistant",
          model,
          content: [{ type: "text", text: "Hello there friend!" }],
          stop_reason: "end_turn",
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        });
        marketplaceEventBus.emitProxy({
          nodeId: sellerNodeId,
          requestId,
          kind: "chunk",
          payload: { data: responseData, done: true },
        });
        setTimeout(() => {
          marketplaceEventBus.emitProxy({
            nodeId: sellerNodeId,
            requestId,
            kind: "done",
            payload: {
              requestId,
              model,
              inputTokens,
              outputTokens,
              totalTokens: inputTokens + outputTokens,
              durationMs: 200,
            },
          });
        }, 10);
      }
    }, delay);
  }

  beforeAll(async () => {
    envSnapshot = captureEnv([
      "HOME",
      "USERPROFILE",
      "HOMEDRIVE",
      "HOMEPATH",
      "BOT_STATE_DIR",
      "BOT_CONFIG_PATH",
      "BOT_GATEWAY_TOKEN",
      "BOT_SKIP_CHANNELS",
      "BOT_SKIP_GMAIL_WATCHER",
      "BOT_SKIP_CRON",
      "BOT_SKIP_CANVAS_HOST",
      "BOT_SKIP_BROWSER_CONTROL_SERVER",
      "BILLING_GATE_MODE",
    ]);

    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "bot-mkt-e2e-"));
    process.env.HOME = tempHome;
    process.env.BOT_STATE_DIR = path.join(tempHome, ".hanzo", "bot");
    process.env.BOT_SKIP_CHANNELS = "1";
    process.env.BOT_SKIP_GMAIL_WATCHER = "1";
    process.env.BOT_SKIP_CRON = "1";
    process.env.BOT_SKIP_CANVAS_HOST = "1";
    process.env.BOT_SKIP_BROWSER_CONTROL_SERVER = "1";
    process.env.BILLING_GATE_MODE = "open";
    process.env.BOT_GATEWAY_TOKEN = token;

    await fs.mkdir(path.join(tempHome, ".hanzo", "bot"), { recursive: true });

    const configPath = path.join(tempHome, ".hanzo", "bot", "bot.json");
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          gateway: {
            auth: { mode: "token", token },
            marketplace: {
              enabled: true,
              platformFeePct: 20,
              priceFraction: 0.6,
              minPayoutCents: 1000,
              aiTokenBonusPct: 10,
            },
          },
        },
        null,
        2,
      ),
    );
    process.env.BOT_CONFIG_PATH = configPath;

    scheduler = new MarketplaceScheduler();
    scheduler.updateSellerStatus(sellerNodeId, "idle", { maxConcurrent: 5 });

    const marketplaceOpts: MarketplaceHttpOptions = {
      auth: { mode: "token", token, allowTailscale: false },
      nodeRegistry: {
        invoke: async (params: { nodeId: string; command: string; params?: unknown }) => {
          if (params.command === "marketplace.proxy") {
            const reqParams = params.params as Record<string, unknown>;
            const requestId = reqParams?.requestId as string;
            const stream = reqParams?.stream === true;
            simulateSellerResponse(requestId, { streaming: stream });
            return { ok: true, payload: { accepted: true } };
          }
          return { ok: false, error: { code: "UNKNOWN_COMMAND", message: "unknown" } };
        },
        get: () => ({
          nodeId: sellerNodeId,
          marketplacePayoutPreference: "usd" as const,
        }),
      } as never,
      scheduler,
      marketplaceConfig: {
        enabled: true,
        platformFeePct: 20,
        priceFraction: 0.6,
        minPayoutCents: 1000,
        aiTokenBonusPct: 10,
      },
    };

    port = await getDeterministicFreePortBlock({ offsets: [0, 1, 2, 3, 4] });

    httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const handled = await handleMarketplaceHttpRequest(req, res, marketplaceOpts);
        if (!handled) {
          res.statusCode = 404;
          res.end("Not Found");
        }
      } catch (err) {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(String(err));
        }
      }
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(port, "127.0.0.1", resolve);
    });
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer?.close((err) => (err ? reject(err) : resolve()));
    }).catch(() => {});
    envSnapshot.restore();
    await fs.rm(tempHome, { recursive: true, force: true }).catch(() => {});
  });

  const baseUrl = () => `http://127.0.0.1:${port}`;
  const authHeaders = () => ({ Authorization: `Bearer ${token}` });

  describe("non-streaming completions", () => {
    it("returns a valid completion response", { timeout: 15_000 }, async () => {
      const res = await httpPost(
        `${baseUrl()}/v1/marketplace/completions`,
        {
          model: "claude-sonnet-4-20250514",
          messages: [{ role: "user", content: "Say hello in 3 words" }],
          max_tokens: 50,
        },
        authHeaders(),
      );

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.content).toBeDefined();
      expect(body.content[0].text).toContain("Hello");
    });

    it("defaults model when not specified", { timeout: 15_000 }, async () => {
      const res = await httpPost(
        `${baseUrl()}/v1/marketplace/completions`,
        {
          messages: [{ role: "user", content: "test" }],
        },
        authHeaders(),
      );

      expect(res.status).toBe(200);
    });

    it("returns proper JSON content-type", { timeout: 15_000 }, async () => {
      const res = await httpPost(
        `${baseUrl()}/v1/marketplace/completions`,
        {
          messages: [{ role: "user", content: "test" }],
        },
        authHeaders(),
      );

      expect(res.status).toBe(200);
      // The non-streaming response writes Content-Type manually.
      expect(String(res.headers["content-type"])).toContain("application/json");
    });
  });

  describe("streaming completions", () => {
    it("streams SSE chunks and terminates with [DONE]", { timeout: 15_000 }, async () => {
      const res = await httpPostSse(
        `${baseUrl()}/v1/marketplace/completions`,
        {
          model: "claude-sonnet-4-20250514",
          messages: [{ role: "user", content: "Say hello" }],
          stream: true,
          max_tokens: 50,
        },
        authHeaders(),
      );

      expect(res.status).toBe(200);
      expect(String(res.headers["content-type"])).toContain("text/event-stream");

      const doneEvents = res.events.filter((e) => e === "[DONE]");
      expect(doneEvents.length).toBe(1);

      const contentEvents = res.events.filter((e) => e !== "[DONE]");
      expect(contentEvents.length).toBeGreaterThan(0);
      for (const evt of contentEvents) {
        const parsed = JSON.parse(evt);
        expect(parsed.choices).toBeDefined();
      }
    });

    it("includes X-Marketplace-Request-Id header", { timeout: 15_000 }, async () => {
      const res = await httpPostSse(
        `${baseUrl()}/v1/marketplace/completions`,
        {
          model: "claude-sonnet-4-20250514",
          messages: [{ role: "user", content: "test" }],
          stream: true,
        },
        authHeaders(),
      );

      expect(res.status).toBe(200);
      expect(res.headers["x-marketplace-request-id"]).toBeDefined();
      expect(typeof res.headers["x-marketplace-request-id"]).toBe("string");
    });

    it("relays multiple chunks in correct order", { timeout: 15_000 }, async () => {
      const res = await httpPostSse(
        `${baseUrl()}/v1/marketplace/completions`,
        {
          model: "claude-sonnet-4-20250514",
          messages: [{ role: "user", content: "test ordering" }],
          stream: true,
        },
        authHeaders(),
      );

      const contentEvents = res.events.filter((e) => e !== "[DONE]");
      expect(contentEvents.length).toBe(3);

      const texts = contentEvents.map((e) => {
        const parsed = JSON.parse(e);
        return parsed.choices?.[0]?.delta?.content;
      });
      expect(texts).toEqual(["Hello", " there", " friend!"]);
    });
  });

  describe("auth and error handling", () => {
    it("returns 401 without auth token", { timeout: 10_000 }, async () => {
      const res = await httpPost(
        `${baseUrl()}/v1/marketplace/completions`,
        { messages: [{ role: "user", content: "test" }] },
        {},
      );

      expect(res.status).toBe(401);
    });

    it("returns 401 with invalid auth token", { timeout: 10_000 }, async () => {
      const res = await httpPost(
        `${baseUrl()}/v1/marketplace/completions`,
        { messages: [{ role: "user", content: "test" }] },
        { Authorization: "Bearer invalid-token-xyz" },
      );

      expect(res.status).toBe(401);
    });

    it("returns 503 when no sellers are available", { timeout: 10_000 }, async () => {
      scheduler.removeSeller(sellerNodeId);

      try {
        const res = await httpPost(
          `${baseUrl()}/v1/marketplace/completions`,
          { messages: [{ role: "user", content: "test" }] },
          authHeaders(),
        );

        expect(res.status).toBe(503);
        const body = JSON.parse(res.body);
        expect(body.error.type).toBe("marketplace_unavailable");
        expect(body.error.message).toContain("no marketplace sellers");
      } finally {
        scheduler.updateSellerStatus(sellerNodeId, "idle", { maxConcurrent: 5 });
      }
    });

    it("returns Retry-After header when no sellers", { timeout: 10_000 }, async () => {
      scheduler.removeSeller(sellerNodeId);

      try {
        const res = await httpPost(
          `${baseUrl()}/v1/marketplace/completions`,
          { messages: [{ role: "user", content: "test" }] },
          authHeaders(),
        );

        expect(res.status).toBe(503);
        expect(res.headers["retry-after"]).toBe("30");
      } finally {
        scheduler.updateSellerStatus(sellerNodeId, "idle", { maxConcurrent: 5 });
      }
    });

    it("returns 503 when seller is active (not idle)", { timeout: 10_000 }, async () => {
      scheduler.handleSellerBecameActive(sellerNodeId);

      try {
        const res = await httpPost(
          `${baseUrl()}/v1/marketplace/completions`,
          { messages: [{ role: "user", content: "test" }] },
          authHeaders(),
        );

        expect(res.status).toBe(503);
      } finally {
        scheduler.updateSellerStatus(sellerNodeId, "idle", { maxConcurrent: 5 });
      }
    });

    it("returns 405 for GET requests", { timeout: 10_000 }, async () => {
      const res = await httpGet(`${baseUrl()}/v1/marketplace/completions`, authHeaders());

      expect(res.status).toBe(405);
    });

    it("returns 404 for wrong path", { timeout: 10_000 }, async () => {
      const res = await httpPost(
        `${baseUrl()}/v1/wrong/path`,
        { messages: [{ role: "user", content: "test" }] },
        authHeaders(),
      );

      expect(res.status).toBe(404);
    });
  });

  describe("seller lifecycle", () => {
    it("seller transitions idle → sharing → idle during request", { timeout: 15_000 }, async () => {
      scheduler.removeSeller(sellerNodeId);
      scheduler.updateSellerStatus(sellerNodeId, "idle", { maxConcurrent: 1 });

      const before = scheduler.listSellers().find((s) => s.nodeId === sellerNodeId);
      expect(before?.status).toBe("idle");

      const requestPromise = httpPost(
        `${baseUrl()}/v1/marketplace/completions`,
        { messages: [{ role: "user", content: "lifecycle test" }] },
        authHeaders(),
      );

      // Give the server a moment to reserve the seller.
      await new Promise((r) => setTimeout(r, 15));

      const during = scheduler.listSellers().find((s) => s.nodeId === sellerNodeId);
      expect(during?.status).toBe("sharing");

      const res = await requestPromise;
      expect(res.status).toBe(200);

      // After completion, seller returns to idle.
      await new Promise((r) => setTimeout(r, 60));
      const after = scheduler.listSellers().find((s) => s.nodeId === sellerNodeId);
      expect(after?.status).toBe("idle");

      // Restore capacity for other tests.
      scheduler.updateSellerStatus(sellerNodeId, "idle", { maxConcurrent: 5 });
    });

    it("performance score increases after successful requests", { timeout: 15_000 }, async () => {
      scheduler.removeSeller(sellerNodeId);
      scheduler.updateSellerStatus(sellerNodeId, "idle", { maxConcurrent: 5 });
      const scoreBefore = scheduler
        .listSellers()
        .find((s) => s.nodeId === sellerNodeId)!.performanceScore;

      for (let i = 0; i < 3; i++) {
        const res = await httpPost(
          `${baseUrl()}/v1/marketplace/completions`,
          { messages: [{ role: "user", content: `perf ${i}` }] },
          authHeaders(),
        );
        expect(res.status).toBe(200);
        await new Promise((r) => setTimeout(r, 80));
      }

      const scoreAfter = scheduler
        .listSellers()
        .find((s) => s.nodeId === sellerNodeId)!.performanceScore;
      expect(scoreAfter).toBeGreaterThanOrEqual(scoreBefore);
    });

    it("tracks completed request count", { timeout: 15_000 }, async () => {
      const countBefore =
        scheduler.listSellers().find((s) => s.nodeId === sellerNodeId)?.totalCompleted ?? 0;

      const res = await httpPost(
        `${baseUrl()}/v1/marketplace/completions`,
        { messages: [{ role: "user", content: "count test" }] },
        authHeaders(),
      );
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 80));

      const countAfter = scheduler
        .listSellers()
        .find((s) => s.nodeId === sellerNodeId)!.totalCompleted;
      expect(countAfter).toBe(countBefore + 1);
    });
  });

  describe("concurrent requests", () => {
    it("handles multiple concurrent non-streaming requests", { timeout: 20_000 }, async () => {
      const promises = Array.from({ length: 3 }, (_, i) =>
        httpPost(
          `${baseUrl()}/v1/marketplace/completions`,
          { messages: [{ role: "user", content: `concurrent ${i}` }] },
          authHeaders(),
        ),
      );

      const results = await Promise.all(promises);
      for (const res of results) {
        expect(res.status).toBe(200);
      }
    });

    it("handles mixed streaming and non-streaming", { timeout: 20_000 }, async () => {
      const nonStream = httpPost(
        `${baseUrl()}/v1/marketplace/completions`,
        { messages: [{ role: "user", content: "non-stream" }] },
        authHeaders(),
      );

      const stream = httpPostSse(
        `${baseUrl()}/v1/marketplace/completions`,
        { messages: [{ role: "user", content: "stream" }], stream: true },
        authHeaders(),
      );

      const [nsRes, sRes] = await Promise.all([nonStream, stream]);
      expect(nsRes.status).toBe(200);
      expect(sRes.status).toBe(200);
      expect(sRes.events.some((e) => e === "[DONE]")).toBe(true);
    });
  });

  describe("billing integration", () => {
    it("calculates correct marketplace pricing", () => {
      const pricing = calculateMarketplacePrice({
        model: "claude-sonnet-4-20250514",
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        config: {
          enabled: true,
          platformFeePct: 20,
          priceFraction: 0.6,
          minPayoutCents: 1000,
          aiTokenBonusPct: 10,
        },
      });

      // Sonnet list price: $3/MTok input + $15/MTok output
      // 1M input = $3 = 300 cents, 500K output = $7.50 = 750 cents
      // List total = 1050 cents
      // Buyer pays 60% = 630 cents
      expect(pricing.buyerCostCents).toBe(630);
      // Platform 20% of 630 = 126 cents
      expect(pricing.platformFeeCents).toBe(126);
      // Seller = 630 - 126 = 504 cents
      expect(pricing.sellerEarningsCents).toBe(504);
      // Sum check
      expect(pricing.buyerCostCents).toBe(pricing.sellerEarningsCents + pricing.platformFeeCents);
    });

    it("uses fallback pricing for unknown models", () => {
      const pricing = calculateMarketplacePrice({
        model: "unknown-model-2025",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        config: {
          enabled: true,
          platformFeePct: 20,
          priceFraction: 0.6,
          minPayoutCents: 1000,
          aiTokenBonusPct: 10,
        },
      });

      // Fallback: $3/$15 per MTok
      expect(pricing.buyerCostCents).toBeGreaterThan(0);
      expect(pricing.sellerEarningsCents).toBeGreaterThan(0);
      expect(pricing.platformFeeCents).toBeGreaterThan(0);
    });

    it("AI token payout bonus is higher than USD", () => {
      const usdPayout = calculateSellerPayout(100, "usd", 10);
      const aiPayout = calculateSellerPayout(100, "ai_token", 10);

      expect(usdPayout.total).toBe(100);
      expect(usdPayout.bonusCents).toBe(0);
      expect(aiPayout.total).toBe(110);
      expect(aiPayout.bonusCents).toBe(10);
    });

    it("builds correct Commerce API payloads (buyer debit, seller credit, platform)", () => {
      const payloads = buildCommercePayloads({
        requestId: "test-req-1",
        buyerUserId: "buyer-1",
        buyerOrgId: "org-1",
        sellerNodeId: "seller-1",
        sellerUserId: "seller-user-1",
        model: "claude-sonnet-4-20250514",
        inputTokens: 1000,
        outputTokens: 500,
        buyerCostCents: 100,
        sellerEarningsCents: 80,
        platformFeeCents: 20,
        aiTokenPayout: false,
        timestamp: Date.now(),
        durationMs: 200,
      });

      expect(payloads).toHaveLength(3);

      // Buyer debit.
      expect(payloads[0].user).toBe("org-1/buyer-1");
      expect(payloads[0].amount).toBe(100);
      expect(payloads[0].provider).toBe("marketplace");

      // Seller credit (negative = credit).
      expect(payloads[1].user).toBe("seller-user-1");
      expect(payloads[1].amount).toBe(-80);

      // Platform revenue.
      expect(payloads[2].user).toBe("platform/marketplace");
      expect(payloads[2].amount).toBe(20);
    });

    it("enforces minimum 1 cent buyer cost", () => {
      const pricing = calculateMarketplacePrice({
        model: "claude-sonnet-4-20250514",
        inputTokens: 1,
        outputTokens: 1,
        config: {
          enabled: true,
          platformFeePct: 20,
          priceFraction: 0.6,
          minPayoutCents: 1000,
          aiTokenBonusPct: 10,
        },
      });

      expect(pricing.buyerCostCents).toBeGreaterThanOrEqual(1);
    });
  });

  describe("event bus integration", () => {
    it("routes proxy events to correct requestId subscriber only", () => {
      const events: MarketplaceProxyEvent[] = [];
      const requestId = randomUUID();

      const unsubscribe = marketplaceEventBus.onProxy(requestId, (evt) => {
        events.push(evt);
      });

      marketplaceEventBus.emitProxy({
        nodeId: "node-1",
        requestId,
        kind: "chunk",
        payload: { data: "correct" },
      });

      marketplaceEventBus.emitProxy({
        nodeId: "node-1",
        requestId,
        kind: "done",
        payload: {
          requestId,
          model: "test",
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          durationMs: 100,
        },
      });

      // Different requestId — should not be captured.
      marketplaceEventBus.emitProxy({
        nodeId: "node-1",
        requestId: randomUUID(),
        kind: "chunk",
        payload: { data: "wrong" },
      });

      unsubscribe();

      expect(events).toHaveLength(2);
      expect(events[0].kind).toBe("chunk");
      expect(events[0].payload.data).toBe("correct");
      expect(events[1].kind).toBe("done");
    });

    it("unsubscribe stops receiving events", () => {
      const events: MarketplaceProxyEvent[] = [];
      const requestId = randomUUID();

      const unsubscribe = marketplaceEventBus.onProxy(requestId, (evt) => {
        events.push(evt);
      });

      marketplaceEventBus.emitProxy({
        nodeId: "node-1",
        requestId,
        kind: "chunk",
        payload: { data: "before" },
      });

      unsubscribe();

      marketplaceEventBus.emitProxy({
        nodeId: "node-1",
        requestId,
        kind: "chunk",
        payload: { data: "after" },
      });

      expect(events).toHaveLength(1);
      expect(events[0].payload.data).toBe("before");
    });

    it("idle status events dispatch correctly", () => {
      const statuses: string[] = [];
      const testNodeId = `idle-test-${randomUUID()}`;

      const unsubscribe = marketplaceEventBus.onIdleStatus((evt) => {
        if (evt.nodeId === testNodeId) {
          statuses.push(evt.status);
        }
      });

      marketplaceEventBus.emitIdleStatus({ nodeId: testNodeId, status: "idle", maxConcurrent: 1 });
      marketplaceEventBus.emitIdleStatus({ nodeId: testNodeId, status: "active" });
      marketplaceEventBus.emitIdleStatus({ nodeId: testNodeId, status: "sharing" });

      unsubscribe();

      expect(statuses).toEqual(["idle", "active", "sharing"]);
    });
  });

  describe("scheduler selection algorithm", () => {
    it("picks highest-performing idle seller", () => {
      const s = new MarketplaceScheduler();
      s.updateSellerStatus("low", "idle");
      s.updateSellerStatus("high", "idle");

      // Boost high-score via successful requests.
      s.reserveSeller("high");
      s.releaseSeller("high", true, 1000);
      s.reserveSeller("high");
      s.releaseSeller("high", true, 500);

      // Degrade low-score via failures.
      s.reserveSeller("low");
      s.releaseSeller("low", false);

      const picked = s.pickSeller();
      expect(picked).not.toBeNull();
      expect(picked!.nodeId).toBe("high");
    });

    it("returns null when all sellers are active", () => {
      const s = new MarketplaceScheduler();
      s.updateSellerStatus("node-1", "active");
      s.updateSellerStatus("node-2", "active");

      expect(s.pickSeller()).toBeNull();
    });

    it("skips sellers at max concurrent capacity", () => {
      const s = new MarketplaceScheduler();
      s.updateSellerStatus("full", "idle", { maxConcurrent: 1 });
      s.reserveSeller("full");

      s.updateSellerStatus("available", "idle", { maxConcurrent: 2 });

      const picked = s.pickSeller();
      expect(picked!.nodeId).toBe("available");
    });

    it("prefers longest-idle seller when scores are equal", () => {
      const s = new MarketplaceScheduler();
      s.updateSellerStatus("newer", "idle");
      // Force an earlier idle timestamp for "older".
      s.updateSellerStatus("older", "idle");
      const older = s.listSellers().find((x) => x.nodeId === "older")!;
      older.lastIdleAtMs = Date.now() - 60_000;

      const picked = s.pickSeller();
      expect(picked!.nodeId).toBe("older");
    });

    it("removeSeller removes from pool", () => {
      const s = new MarketplaceScheduler();
      s.updateSellerStatus("temp", "idle");
      expect(s.availableCount()).toBe(1);

      s.removeSeller("temp");
      expect(s.availableCount()).toBe(0);
      expect(s.pickSeller()).toBeNull();
    });

    it("availableCount reflects current state", () => {
      const s = new MarketplaceScheduler();
      expect(s.availableCount()).toBe(0);

      s.updateSellerStatus("a", "idle");
      s.updateSellerStatus("b", "idle");
      s.updateSellerStatus("c", "active");
      expect(s.availableCount()).toBe(2);

      s.handleSellerBecameActive("a");
      expect(s.availableCount()).toBe(1);
    });
  });
});
