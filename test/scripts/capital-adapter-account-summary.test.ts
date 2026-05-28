import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const originalCapitalHftDir = process.env.CAPITAL_HFT_DIR;

async function importCapitalAdapterFrom(tempDir) {
  process.env.CAPITAL_HFT_DIR = tempDir;
  vi.resetModules();
  const { CapitalAdapter } =
    await import("../../scripts/strategy-engine/brokers/CapitalAdapter.mjs");
  return new CapitalAdapter({ mode: "paper" });
}

afterEach(() => {
  vi.resetModules();
  if (originalCapitalHftDir === undefined) {
    delete process.env.CAPITAL_HFT_DIR;
    return;
  }
  process.env.CAPITAL_HFT_DIR = originalCapitalHftDir;
});

describe("strategy-engine CapitalAdapter getAccountSummary", () => {
  it("keeps zero account fields as numeric zero instead of null", async () => {
    const capitalHftDir = createTempDir("openclaw-capital-adapter-summary-");
    const generatedAt = "2026-05-26T00:00:00.000Z";

    await fs.writeFile(
      path.join(capitalHftDir, "hft_rights.json"),
      JSON.stringify({
        rights: 0,
        margin: 0,
        availableBalance: 0,
        generatedAt,
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(capitalHftDir, "hft_os_rights.json"),
      JSON.stringify({
        rights: 0,
        margin: 0,
        availableBalance: 0,
        generatedAt,
      }),
      "utf8",
    );

    const adapter = await importCapitalAdapterFrom(capitalHftDir);
    const summary = await adapter.getAccountSummary();

    expect(summary.equity).toBe(0);
    expect(summary.margin).toBe(0);
    expect(summary.available).toBe(0);
    expect(summary.osEquity).toBe(0);
    expect(summary.osMargin).toBe(0);
    expect(summary.osAvailable).toBe(0);
    expect(summary.source).toBe("hft_rights_json");
    expect(summary.updatedAt).toBe(generatedAt);
  });

  it("degrades safely when rights files are missing", async () => {
    const capitalHftDir = createTempDir("openclaw-capital-adapter-summary-missing-");
    const adapter = await importCapitalAdapterFrom(capitalHftDir);
    const summary = await adapter.getAccountSummary();

    expect(summary).toMatchObject({
      equity: null,
      margin: null,
      available: null,
      currency: "TWD",
    });
    expect(summary.note).toContain("紙上模式");
  });

  it("degrades safely with diagnostic note when rights files are invalid JSON", async () => {
    const capitalHftDir = createTempDir("openclaw-capital-adapter-summary-invalid-json-");
    await fs.writeFile(path.join(capitalHftDir, "hft_rights.json"), "{ invalid json", "utf8");
    await fs.writeFile(
      path.join(capitalHftDir, "hft_os_rights.json"),
      JSON.stringify({
        rights: 100,
        margin: 20,
        availableBalance: 80,
        generatedAt: "2026-05-26T01:00:00.000Z",
      }),
      "utf8",
    );

    const adapter = await importCapitalAdapterFrom(capitalHftDir);
    const summary = await adapter.getAccountSummary();
    expect(summary).toMatchObject({
      equity: null,
      margin: null,
      available: null,
      currency: "TWD",
    });
    expect(summary.note).toContain("紙上模式");
  });

  it("keeps malformed numeric fields nullable without throwing", async () => {
    const capitalHftDir = createTempDir("openclaw-capital-adapter-summary-malformed-fields-");
    const generatedAt = "2026-05-26T02:00:00.000Z";
    await fs.writeFile(
      path.join(capitalHftDir, "hft_rights.json"),
      JSON.stringify({
        rights: "not-a-number",
        generatedAt,
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(capitalHftDir, "hft_os_rights.json"),
      JSON.stringify({
        rights: null,
        margin: "NaN",
        availableBalance: undefined,
        generatedAt,
      }),
      "utf8",
    );

    const adapter = await importCapitalAdapterFrom(capitalHftDir);
    const summary = await adapter.getAccountSummary();
    expect(summary.equity).toBeNull();
    expect(summary.margin).toBeNull();
    expect(summary.available).toBeNull();
    expect(summary.osEquity).toBeNull();
    expect(summary.osMargin).toBeNull();
    expect(summary.osAvailable).toBeNull();
    expect(summary.source).toBe("hft_rights_json");
    expect(summary.updatedAt).toBe(generatedAt);
  });
});

describe("strategy-engine sizing integration", () => {
  it("uses overseas equity source for USD contract sizing", async () => {
    vi.resetModules();
    const { StrategyEngine } = await import("../../scripts/strategy-engine/StrategyEngine.mjs");
    const getDomesticCapital = vi.fn(() => 900_000);
    const getOverseasCapital = vi.fn(() => 42_000);
    const calc = vi.fn(function calcUsingCurrentMaxQty() {
      return this.maxQty;
    });
    const updateCapital = vi.fn();
    const engine = new StrategyEngine({
      dryRun: true,
      equitySizer: {
        domestic: { maxContracts: 2 },
        overseas: { maxContracts: 9 },
      },
    });

    engine.sizer = {
      maxQty: 12,
      riskPct: 0.01,
      stopMult: 2,
      pointValue: 200,
      updateCapital,
      calc,
    };
    engine.equityBridge = {
      getDomesticCapital,
      getOverseasCapital,
      getMaxPositionContracts: () => null,
    };

    const qty = engine._calcSignalQty({ instrument: "CNZ26", price: 10000 }, { _priceHistory: [] });

    expect(getOverseasCapital).toHaveBeenCalledTimes(1);
    expect(getDomesticCapital).not.toHaveBeenCalled();
    expect(updateCapital).toHaveBeenCalledWith(42_000);
    expect(calc).toHaveBeenCalledWith(expect.objectContaining({ margin: 1200 }));
    expect(qty).toBe(9);
  });

  it("truncates qty to API max contracts and allows boundary qty", async () => {
    vi.resetModules();
    const { StrategyEngine } = await import("../../scripts/strategy-engine/StrategyEngine.mjs");
    const getMaxPositionContracts = vi.fn(() => 5.9);
    const calc = vi.fn(function calcUsingCurrentMaxQty() {
      return this.maxQty;
    });
    const engine = new StrategyEngine({
      dryRun: true,
      equitySizer: {
        overseas: { maxContracts: 12 },
      },
    });
    engine.sizer = {
      maxQty: 12,
      riskPct: 0.01,
      stopMult: 2,
      pointValue: 200,
      updateCapital: vi.fn(),
      calc,
    };
    engine.equityBridge = {
      getDomesticCapital: () => 1_000_000,
      getOverseasCapital: () => 50_000,
      getMaxPositionContracts,
    };

    const cappedQty = engine._calcSignalQty(
      { instrument: "CNU26", price: 10000 },
      { _priceHistory: [] },
    );
    expect(cappedQty).toBe(5);

    getMaxPositionContracts.mockReturnValue(5);
    const boundaryQty = engine._calcSignalQty(
      { instrument: "CNU26", price: 10000 },
      { _priceHistory: [] },
    );
    expect(boundaryQty).toBe(5);
  });

  it("does not route orders when risk gate rejects over-limit quantity", async () => {
    vi.resetModules();
    const { StrategyEngine } = await import("../../scripts/strategy-engine/StrategyEngine.mjs");
    const engine = new StrategyEngine({ dryRun: true, pollMs: 1 });
    const routeSignal = vi.fn(async () => ({ ok: true }));
    const riskCheck = vi.fn(() => ({ ok: false, reason: "max position exceeded" }));
    let emitted = false;

    engine.router = {
      dryRun: true,
      routeSignal,
    };
    engine.riskController = {
      check: riskCheck,
    };
    engine.strategies = [
      {
        _enabled: true,
        name: "max-position-test",
        _priceHistory: [],
        popSignals() {
          if (emitted) {
            engine._running = false;
            return [];
          }
          emitted = true;
          return [
            {
              strategy: "max-position-test",
              broker: "capital",
              instrument: "CNU26",
              direction: "buy",
              qty: 6,
              autoExecute: true,
              reason: "qty over limit",
            },
          ];
        },
        lastBar() {
          return null;
        },
      },
    ];

    engine._running = true;
    await engine._loop();

    expect(riskCheck).toHaveBeenCalledWith(expect.objectContaining({ qty: 6 }));
    expect(routeSignal).not.toHaveBeenCalled();
  });
});
