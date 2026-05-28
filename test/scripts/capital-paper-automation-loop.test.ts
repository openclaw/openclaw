import { describe, expect, it } from "vitest";
import { strategyEngineSymbolForPaperConfig } from "../../scripts/openclaw-capital-paper-automation-loop.mjs";

describe("capital paper automation loop", () => {
  it("does not pass legacy session aliases into the strategy engine", () => {
    expect(strategyEngineSymbolForPaperConfig({ targetStockNo: "TX00AM" })).toBe("TX00");
    expect(strategyEngineSymbolForPaperConfig({ targetStockNo: "TX00PM" })).toBe("TX00");
    expect(strategyEngineSymbolForPaperConfig({ targetStockNo: "TX06AM" })).toBe("TX06");
    expect(strategyEngineSymbolForPaperConfig({ symbol: "tx-front" })).toBe("tx-front");
  });
});
