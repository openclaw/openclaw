/**
 * L1 Unit Tests — ExchangeRegistry
 *
 * Tests: register/remove exchanges, config retrieval, duplicate handling,
 * list formatting, instance caching, closeAll cleanup.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ExchangeRegistry } from "../../../extensions/findoo-trader-plugin/src/core/exchange-registry.js";
import type { ExchangeConfig } from "../../../extensions/findoo-trader-plugin/src/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<ExchangeConfig>): ExchangeConfig {
  return {
    exchange: "binance",
    apiKey: "test-key",
    secret: "test-secret",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("ExchangeRegistry", () => {
  let registry: ExchangeRegistry;

  beforeEach(() => {
    registry = new ExchangeRegistry();
  });

  // 1. Basic registration
  it("registers an exchange and retrieves its config", () => {
    const config = makeConfig({ exchange: "okx" });
    registry.addExchange("my-okx", config);

    expect(registry.getConfig("my-okx")).toEqual(config);
  });

  // 2. List returns all registered exchanges
  it("lists all registered exchanges with id, exchange, testnet", () => {
    registry.addExchange("prod-binance", makeConfig({ testnet: false }));
    registry.addExchange("test-bybit", makeConfig({ exchange: "bybit", testnet: true }));

    const list = registry.listExchanges();
    expect(list).toHaveLength(2);
    expect(list).toEqual(
      expect.arrayContaining([
        { id: "prod-binance", exchange: "binance", testnet: false },
        { id: "test-bybit", exchange: "bybit", testnet: true },
      ]),
    );
  });

  // 3. testnet defaults to false when omitted
  it("defaults testnet to false when not specified", () => {
    registry.addExchange("no-testnet", makeConfig());

    const list = registry.listExchanges();
    expect(list[0].testnet).toBe(false);
  });

  // 4. Remove exchange
  it("removes an exchange and returns true", () => {
    registry.addExchange("x1", makeConfig());

    expect(registry.removeExchange("x1")).toBe(true);
    expect(registry.getConfig("x1")).toBeUndefined();
    expect(registry.listExchanges()).toHaveLength(0);
  });

  // 5. Remove non-existent exchange returns false
  it("returns false when removing a non-existent exchange", () => {
    expect(registry.removeExchange("ghost")).toBe(false);
  });

  // 6. Overwrite existing exchange (re-register)
  it("overwrites config when adding with the same ID", () => {
    registry.addExchange("dup", makeConfig({ exchange: "binance" }));
    registry.addExchange("dup", makeConfig({ exchange: "okx" }));

    expect(registry.getConfig("dup")!.exchange).toBe("okx");
    expect(registry.listExchanges()).toHaveLength(1);
  });

  // 7. Re-register clears cached instance
  it("clears cached instance when re-registering an exchange", async () => {
    // We can't easily test ccxt import, but we can verify the instance map
    // is cleared by checking that getInstance throws for a valid re-registered config
    // without ccxt available. The key behavior: instances map is deleted on addExchange.
    registry.addExchange("a", makeConfig());
    // Simulate a cached instance by accessing private map (white-box)
    (registry as unknown as { instances: Map<string, unknown> }).instances.set("a", {
      close: vi.fn(),
    });

    // Re-register should clear the cached instance
    registry.addExchange("a", makeConfig({ exchange: "bybit" }));

    const instances = (registry as unknown as { instances: Map<string, unknown> }).instances;
    expect(instances.has("a")).toBe(false);
  });

  // 8. getConfig returns undefined for unknown ID
  it("returns undefined for unknown exchange ID", () => {
    expect(registry.getConfig("nonexistent")).toBeUndefined();
  });

  // 9. getInstance throws for unconfigured exchange
  it("throws when getting instance for unconfigured exchange", async () => {
    await expect(registry.getInstance("missing")).rejects.toThrow(
      'Exchange "missing" not configured',
    );
  });

  // 10. closeAll closes all instances and clears the map
  it("closeAll invokes close() on all cached instances", async () => {
    const closeFn1 = vi.fn().mockResolvedValue(undefined);
    const closeFn2 = vi.fn().mockResolvedValue(undefined);

    const instances = (registry as unknown as { instances: Map<string, unknown> }).instances;
    instances.set("a", { close: closeFn1 });
    instances.set("b", { close: closeFn2 });

    await registry.closeAll();

    expect(closeFn1).toHaveBeenCalledOnce();
    expect(closeFn2).toHaveBeenCalledOnce();
    expect(instances.size).toBe(0);
  });

  // 11. closeAll tolerates instances without close()
  it("closeAll handles instances that lack a close method", async () => {
    const instances = (registry as unknown as { instances: Map<string, unknown> }).instances;
    instances.set("no-close", { someOtherMethod: () => {} });

    // Should not throw
    await expect(registry.closeAll()).resolves.toBeUndefined();
    expect(instances.size).toBe(0);
  });

  // 12. closeAll tolerates close() that throws
  it("closeAll swallows errors from close()", async () => {
    const instances = (registry as unknown as { instances: Map<string, unknown> }).instances;
    instances.set("bad", {
      close: vi.fn().mockRejectedValue(new Error("connection reset")),
    });

    await expect(registry.closeAll()).resolves.toBeUndefined();
    expect(instances.size).toBe(0);
  });
});
