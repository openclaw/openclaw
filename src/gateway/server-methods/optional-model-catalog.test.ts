import { afterEach, describe, expect, it, vi } from "vitest";
// Optional model-catalog tests cover fast timeout fallback behavior.
import { MAX_TIMER_TIMEOUT_MS } from "../../shared/number-coercion.js";
import { loadOptionalServerMethodModelCatalog } from "./optional-model-catalog.js";
import type { GatewayRequestContext } from "./types.js";

function createContext(): GatewayRequestContext {
  return {
    loadGatewayModelCatalog: vi.fn(() => new Promise(() => {})),
    logGateway: {
      debug: vi.fn(),
    },
  } as unknown as GatewayRequestContext;
}

describe("loadOptionalServerMethodModelCatalog", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("clamps oversized timeout overrides before scheduling the slow-catalog fallback", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const context = createContext();

    const catalog = loadOptionalServerMethodModelCatalog(context, "agents.list", {
      logOnceKey: "optional-catalog-oversized-timeout-test",
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);

    await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS);

    await expect(catalog).resolves.toBeUndefined();
    expect(context.logGateway.debug).toHaveBeenCalledWith(
      `agents.list continuing without model catalog after ${MAX_TIMER_TIMEOUT_MS}ms`,
    );
  });
});
