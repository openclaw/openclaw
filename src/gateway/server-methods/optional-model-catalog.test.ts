import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "./types.js";

describe("optional-model-catalog slow-load log cache", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function loadCatalog() {
    const mod = await import("./optional-model-catalog.js");
    return mod.loadOptionalServerMethodModelCatalog;
  }

  function makeContext(): GatewayRequestContext {
    return {
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayRequestContext;
  }

  it("caps the dedupe cache at 256 entries and re-logs evicted keys", async () => {
    const loadOptionalServerMethodModelCatalog = await loadCatalog();
    const context = makeContext();
    const surface = "test-surface";
    const neverResolvingLoad = { promise: new Promise<never>(() => {}) };

    for (let i = 0; i < 256; i++) {
      await loadOptionalServerMethodModelCatalog(context, surface, {
        logOnceKey: `key-${i}`,
        timeoutMs: 0,
        startedLoad: neverResolvingLoad,
      });
    }
    expect(context.logGateway.debug).toHaveBeenCalledTimes(256);

    await loadOptionalServerMethodModelCatalog(context, surface, {
      logOnceKey: "key-0",
      timeoutMs: 0,
      startedLoad: neverResolvingLoad,
    });
    expect(context.logGateway.debug).toHaveBeenCalledTimes(256);

    for (let i = 256; i < 512; i++) {
      await loadOptionalServerMethodModelCatalog(context, surface, {
        logOnceKey: `key-${i}`,
        timeoutMs: 0,
        startedLoad: neverResolvingLoad,
      });
    }

    await loadOptionalServerMethodModelCatalog(context, surface, {
      logOnceKey: "key-0",
      timeoutMs: 0,
      startedLoad: neverResolvingLoad,
    });
    expect(context.logGateway.debug).toHaveBeenCalledTimes(513);
  });
});
