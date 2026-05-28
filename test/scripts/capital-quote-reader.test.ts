import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCapitalQuoteState } from "../../scripts/openclaw-capital-quote-reader.mjs";

describe("capital quote reader", () => {
  const originalFreshSeconds = process.env.OPENCLAW_CAPITAL_QUOTE_FRESH_SECONDS;

  beforeEach(() => {
    delete process.env.OPENCLAW_CAPITAL_QUOTE_FRESH_SECONDS;
  });

  afterEach(() => {
    if (originalFreshSeconds === undefined) {
      delete process.env.OPENCLAW_CAPITAL_QUOTE_FRESH_SECONDS;
    } else {
      process.env.OPENCLAW_CAPITAL_QUOTE_FRESH_SECONDS = originalFreshSeconds;
    }
  });

  it("ignores transient half-written hft service status while keeping fresh quote state usable", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-capital-quote-reader-"));
    try {
      const stateDir = path.join(repoRoot, "capital-state");
      await fs.mkdir(stateDir, { recursive: true });
      const marketRegistryPath = path.join(repoRoot, "market-registry.json");
      await fs.writeFile(marketRegistryPath, JSON.stringify({ markets: {} }), "utf8");
      await fs.writeFile(
        path.join(stateDir, "openclaw_quote_bridge.json"),
        JSON.stringify({
          status: "connected",
          overallReady: true,
          quoteEventConfirmed: true,
          currentBlockingCode: "",
        }),
        "utf8",
      );
      await fs.writeFile(
        path.join(stateDir, "capital_latest_quote_event.json"),
        JSON.stringify({
          schema: "openclaw.capital.quote-event.v1",
          receivedAt: new Date().toISOString(),
          eventSource: "SKQuoteLib.OnNotifyQuote",
          stockNo: "TX00",
          stockName: "台指近月",
          close: "100",
          bid: "99",
          ask: "101",
          qty: "1",
        }),
        "utf8",
      );
      await fs.writeFile(
        path.join(stateDir, "hft_service_status.json"),
        '{"loginStatus":"connected","loginMessage":"SK_SUCCESS',
        "utf8",
      );

      const state = await readCapitalQuoteState({
        repoRoot,
        stateDir,
        marketRegistryPath,
        targetStockNo: "TX00",
        targetStockNos: ["TX00"],
      });

      expect(state.status).toBe("connected");
      expect(state.ready).toBe(true);
      expect(state.quote.stockNo).toBe("TX00");
      expect(state.quoteEventFreshness).toBe("fresh");
      expect(state.quoteEventFreshnessThresholdSeconds).toBe(30);
      expect(state.health.bridgeReady).toBe(true);
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });
});
