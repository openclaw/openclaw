import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { LegacyContextEngine } from "./legacy.js";
import {
  listContextEngineQuarantines,
  registerContextEngineInRegistry,
  resolveContextEngine,
  resolveContextEngineOwnerPluginId,
  resolveLogicalTurnContextEngines,
} from "./registry.js";
import { resetContextEngineRuntimeQuarantineForTests } from "./registry.test-support.js";
import type { ContextEngine } from "./types.js";

beforeEach(resetContextEngineRuntimeQuarantineForTests);
afterEach(() => {
  resetContextEngineRuntimeQuarantineForTests();
  vi.restoreAllMocks();
});

function fixture() {
  const registry = createEmptyPluginRegistry();
  const legacyFactory = vi.fn(() => new LegacyContextEngine());
  const engine = {
    info: { id: "display-name", name: "Independent frontier", ownsCompaction: true },
    ingest: async () => ({ ingested: false }),
    assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
    compact: vi.fn(async () => ({ ok: true, compacted: true })),
    dispose: vi.fn(),
  } satisfies ContextEngine;
  const factory = vi.fn(() => engine);
  registerContextEngineInRegistry(registry, "legacy", legacyFactory, "core");
  registerContextEngineInRegistry(registry, "selected", factory, "plugin:owner");
  const config = { plugins: { slots: { contextEngine: "selected" } } };
  return { engine, factory, legacyFactory, registry, config };
}

it("pins healthy compaction and its owner even if a sibling later quarantines the registration", async () => {
  const f = fixture();
  await withPluginRuntimeRegistryScope(f.registry, async () => {
    const pinned = await resolveContextEngine(f.config, { purpose: "compaction" });
    expect(resolveContextEngineOwnerPluginId(pinned)).toBe("owner");
    const guarded = await resolveContextEngine(f.config);
    vi.mocked(f.engine.compact).mockRejectedValueOnce(new Error("sibling failure"));
    await expect(
      guarded.compact({ sessionId: "sibling", sessionKey: "agent:main:sibling" }),
    ).rejects.toThrow("sibling failure");
    const quarantine = listContextEngineQuarantines();
    expect(quarantine).toHaveLength(1);
    expect(resolveContextEngineOwnerPluginId(guarded)).toBeUndefined();
    expect(pinned.info.id).toBe("display-name");
    expect(resolveContextEngineOwnerPluginId(pinned)).toBe("owner");
    await expect(
      pinned.compact({ sessionId: "compaction", sessionKey: "agent:main:compaction" }),
    ).resolves.toMatchObject({
      compacted: true,
    });
    const next = await resolveLogicalTurnContextEngines(f.config);
    expect(resolveContextEngineOwnerPluginId(next.configured.engine)).toBe("owner");
    expect(next.configured.registeredId).toBe("selected");
    expect(listContextEngineQuarantines()).toEqual(quarantine);
    await guarded.dispose?.();
    await pinned.dispose?.();
    await next.configured.engine.dispose?.();
    await next.fallback.engine.dispose?.();
  });
});

it("does not replay failed compaction through legacy and retries only on the next operation", async () => {
  const f = fixture();
  await withPluginRuntimeRegistryScope(f.registry, async () => {
    const engine = await resolveContextEngine(f.config, { purpose: "compaction" });
    vi.mocked(f.engine.compact).mockRejectedValueOnce(new Error("partially mutated frontier"));
    await expect(
      engine.compact({ sessionId: "same", sessionKey: "agent:main:same" }),
    ).rejects.toThrow("partially mutated frontier");
    expect(f.legacyFactory).not.toHaveBeenCalled();
    expect(listContextEngineQuarantines()).toEqual([]);
    await engine.dispose?.();
    const recovered = await resolveContextEngine(f.config, { purpose: "compaction" });
    await expect(
      recovered.compact({ sessionId: "same", sessionKey: "agent:main:same" }),
    ).resolves.toMatchObject({
      compacted: true,
    });
    expect(f.factory).toHaveBeenCalledTimes(2);
    expect(f.engine.compact).toHaveBeenCalledTimes(2);
    await recovered.dispose?.();
  });
});

it.each(["missing", "discovery", "factory", "contract"] as const)(
  "rejects %s selection instead of compacting another frontier",
  async (failure) => {
    const f = fixture();
    if (failure === "missing") {
      f.registry.contextEngines.delete("selected");
    }
    // A runtime registration deliberately cannot be downgraded by discovery; install a fresh discovery entry.
    if (failure === "discovery") {
      f.registry.contextEngines.delete("selected");
      registerContextEngineInRegistry(f.registry, "selected", f.factory, "plugin:owner", {
        lifecycle: "readOnlyDiscovery",
      });
    }
    if (failure === "factory") {
      f.factory.mockImplementation(() => {
        throw new Error("factory unavailable");
      });
    }
    if (failure === "contract") {
      f.engine.info.id = "";
    }
    await withPluginRuntimeRegistryScope(f.registry, async () => {
      await expect(resolveContextEngine(f.config, { purpose: "compaction" })).rejects.toThrow();
      expect(f.legacyFactory).not.toHaveBeenCalled();
      expect(listContextEngineQuarantines()).toEqual([]);
      if (failure === "contract") {
        expect(f.engine.dispose).toHaveBeenCalledOnce();
      }
    });
  },
);

it("uses legacy when configuration explicitly disables the plugin", async () => {
  const f = fixture();
  await withPluginRuntimeRegistryScope(f.registry, async () => {
    const engine = await resolveContextEngine(
      { plugins: { ...f.config.plugins, enabled: false } },
      { purpose: "compaction" },
    );
    expect(engine.info.id).toBe("legacy");
    expect(f.factory).not.toHaveBeenCalled();
    await engine.dispose?.();
  });
});
