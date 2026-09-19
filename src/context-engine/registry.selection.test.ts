import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createContextEngineLogicalTurnLease } from "../agents/harness/context-engine-logical-turn.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { setPluginEnabledInConfig } from "../plugins/toggle-config.js";
import { LegacyContextEngine } from "./legacy.js";
import {
  listContextEngineQuarantines,
  registerContextEngineInRegistry,
  resolveContextEngine,
  resolveContextEngineOwnerPluginId,
  resolveLogicalTurnContextEngines,
} from "./registry.js";
import { resetContextEngineRuntimeQuarantineForTests } from "./registry.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const engineId = "synthetic-engine";
const ownerId = "synthetic-owner";

beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("context-engine-selection-"));
  resetContextEngineRuntimeQuarantineForTests();
});
afterEach(() => {
  resetContextEngineRuntimeQuarantineForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// Each case owns a registry; factories expose invocation independently from selection metadata.
function fixture(owner = engineId, registered = true) {
  const registry = createEmptyPluginRegistry();
  const factory = vi.fn(() => ({
    info: { id: engineId, name: "Synthetic" },
    ingest: async () => ({ ingested: false }),
    assemble: async () => ({ messages: [], estimatedTokens: 0 }),
    compact: async () => ({ ok: true, compacted: false, reason: "fixture" }),
  }));
  registerContextEngineInRegistry(registry, "legacy", () => new LegacyContextEngine(), "core");
  if (registered) {
    registerContextEngineInRegistry(registry, engineId, factory, `plugin:${owner}`);
  }
  return { registry, factory };
}

for (const path of ["standalone", "logical-turn"] as const) {
  describe(path, () => {
    // Exercise both public resolvers and release every returned instance before assertions.
    async function resolve(config: OpenClawConfig) {
      if (path === "standalone") {
        const engine = await resolveContextEngine(config);
        const result = {
          id: engine.info.id,
          owner: resolveContextEngineOwnerPluginId(engine),
          failure: undefined,
        };
        await engine.dispose?.();
        return result;
      }
      const result = await resolveLogicalTurnContextEngines(config);
      await result.configured.engine.dispose?.();
      if (result.configured !== result.fallback) {
        await result.fallback.engine.dispose?.();
      }
      return {
        id: result.configuredId,
        owner: result.configured.ownerPluginId,
        failure: result.configuredFailure,
      };
    }

    it.each([
      ["disabled absent", engineId, false, { entries: { [engineId]: { enabled: false } } }],
      ["disabled registered", engineId, true, { entries: { [engineId]: { enabled: false } } }],
      ["global disable absent", engineId, false, { enabled: false }],
      ["global disable registered", engineId, true, { enabled: false }],
      ["denied absent", engineId, false, { deny: [engineId] }],
      ["denied registered", engineId, true, { deny: [engineId] }],
      ["distinct owner disabled", ownerId, true, { entries: { [ownerId]: { enabled: false } } }],
      ["distinct owner denied", ownerId, true, { deny: [ownerId] }],
    ] satisfies Array<[string, string, boolean, OpenClawConfig["plugins"]]>)(
      "uses normal default for %s",
      async (_name, owner, registered, policy) => {
        const { registry, factory } = fixture(owner, registered);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const config = { plugins: { ...policy, slots: { contextEngine: engineId } } };
        await withPluginRuntimeRegistryScope(registry, async () => {
          expect(await resolve(config)).toEqual({
            id: "legacy",
            owner: undefined,
            failure: undefined,
          });
          expect(listContextEngineQuarantines()).toEqual([]);
        });
        expect(factory).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
        expect(config.plugins.slots.contextEngine).toBe(engineId);
      },
    );

    it.each([undefined, "", "legacy", "none"])("uses default for slot %s", async (slot) => {
      const { registry, factory } = fixture();
      await withPluginRuntimeRegistryScope(registry, async () => {
        expect(
          await resolve({ plugins: { enabled: false, slots: { contextEngine: slot } } }),
        ).toEqual({ id: "legacy", owner: undefined, failure: undefined });
        expect(listContextEngineQuarantines()).toEqual([]);
      });
      expect(factory).not.toHaveBeenCalled();
    });

    it.each([engineId, ownerId])(
      "keeps enabled engine ID separate from owner %s",
      async (owner) => {
        const { registry, factory } = fixture(owner);
        await withPluginRuntimeRegistryScope(registry, async () => {
          expect(
            await resolve({
              plugins: {
                slots: { contextEngine: engineId },
                entries: { [owner]: { enabled: true } },
              },
            }),
          ).toEqual({ id: engineId, owner, failure: undefined });
        });
        expect(factory).toHaveBeenCalledOnce();
      },
    );

    it.each(["missing", "factory"])("preserves enabled %s failure", async (failure) => {
      const { registry, factory } = fixture(engineId, failure !== "missing");
      factory.mockImplementation(() => {
        throw new Error("synthetic factory failure");
      });
      vi.spyOn(console, "error").mockImplementation(() => {});
      await withPluginRuntimeRegistryScope(registry, async () => {
        const result = await resolve({ plugins: { slots: { contextEngine: engineId } } });
        if (path === "logical-turn") {
          expect(result.failure).toContain(
            failure === "missing" ? "not registered" : "synthetic factory failure",
          );
        } else {
          expect(result.id).toBe("legacy");
          expect(listContextEngineQuarantines()).toEqual([
            expect.objectContaining({
              engineId,
              operation: failure === "missing" ? "resolve" : "factory",
            }),
          ]);
        }
      });
    });

    it("disables then re-enables without clearing the retained slot or registering again", async () => {
      const { registry, factory } = fixture();
      const initial = { plugins: { slots: { contextEngine: engineId } } };
      const disabled = setPluginEnabledInConfig(initial, engineId, false);
      await withPluginRuntimeRegistryScope(registry, async () => {
        expect((await resolve(disabled)).id).toBe("legacy");
        expect(factory).not.toHaveBeenCalled();
        expect((await resolve(setPluginEnabledInConfig(disabled, engineId, true))).id).toBe(
          engineId,
        );
        expect(listContextEngineQuarantines()).toEqual([]);
      });
      expect(disabled.plugins?.slots?.contextEngine).toBe(engineId);
      expect(factory).toHaveBeenCalledOnce();
    });
  });
}

it.each([true, false])(
  "plugin disable produces subsequent ordinary logical turns without degradation warnings (registered=%s)",
  async (registered) => {
    const { registry, factory } = fixture(engineId, registered);
    const config = setPluginEnabledInConfig(
      { plugins: { slots: { contextEngine: engineId } } },
      engineId,
      false,
    );
    const warn = vi.fn();
    await withPluginRuntimeRegistryScope(registry, async () => {
      for (const runId of ["first", "second"]) {
        const lease = await createContextEngineLogicalTurnLease({
          config,
          identity: { runId, sessionId: "synthetic-session" },
          warn,
        });
        try {
          lease.begin();
          expect(lease.effectiveEngineId).toBe("legacy");
          expect(lease.degraded).toBe(false);
          await lease.engine.assemble({
            sessionId: "synthetic-session",
            messages: [],
            tokenBudget: 100,
          });
        } finally {
          await lease.dispose();
        }
      }
      expect(listContextEngineQuarantines()).toEqual([]);
    });
    expect(factory).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  },
);
