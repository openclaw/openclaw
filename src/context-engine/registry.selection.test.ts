import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
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
const selectedConfig = { plugins: { slots: { contextEngine: engineId } } };
const legacySelection = { id: "legacy", owner: undefined, failure: undefined };

beforeEach(async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("context-engine-selection-"));
  await resetContextEngineRuntimeQuarantineForTests();
});
afterEach(async () => {
  await resetContextEngineRuntimeQuarantineForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function fixture(owner = engineId, registered = true, selectedId = engineId) {
  const registry = createEmptyPluginRegistry();
  const factory = vi.fn(() => ({
    info: { id: selectedId, name: "Synthetic" },
    ingest: async () => ({ ingested: false }),
    assemble: async () => ({ messages: [], estimatedTokens: 0 }),
    compact: async () => ({ ok: true, compacted: false, reason: "fixture" }),
  }));
  registerContextEngineInRegistry(registry, "legacy", () => new LegacyContextEngine(), "core");
  if (registered) {
    registerContextEngineInRegistry(registry, selectedId, factory, `plugin:${owner}`);
  }
  return { registry, factory };
}

async function resolve(path: "standalone" | "logical-turn", config: OpenClawConfig) {
  const turn = path === "logical-turn" ? await resolveLogicalTurnContextEngines(config) : undefined;
  const engine = turn?.configured.engine ?? (await resolveContextEngine(config));
  const result = {
    id: turn?.configuredId ?? engine.info.id,
    owner: turn ? turn.configured.ownerPluginId : resolveContextEngineOwnerPluginId(engine),
    failure: turn?.configuredFailure,
  };
  await engine.dispose?.();
  if (turn && turn.configured !== turn.fallback) {
    await turn.fallback.engine.dispose?.();
  }
  return result;
}

it("uses the default slot while plugins are disabled", async () => {
  const { registry, factory } = fixture();
  await withPluginRuntimeRegistryScope(registry, async () => {
    expect(
      await resolve("standalone", {
        plugins: { enabled: false, slots: { contextEngine: "legacy" } },
      }),
    ).toEqual(legacySelection);
    expect(await listContextEngineQuarantines()).toEqual([]);
  });
  expect(factory).not.toHaveBeenCalled();
});

it.each(["custom", "rejected", "default", "disabled"] as const)(
  "settles workspace attribution before constructing only a selected custom engine (%s)",
  async (mode) => {
    const { registry, factory } = fixture();
    const entered = createDeferred();
    const baseline = createDeferred();
    const beforeCustomEngine = vi.fn(async () => {
      entered.resolve();
      await baseline.promise;
    });
    const config: OpenClawConfig = {
      plugins: {
        enabled: mode !== "disabled",
        slots: { contextEngine: mode === "default" ? "legacy" : engineId },
      },
    };
    const pending = withPluginRuntimeRegistryScope(registry, () =>
      createContextEngineLogicalTurnLease({
        identity: { runId: `attribution-${mode}`, sessionId: "attribution-session" },
        config,
        awaitSessionDiffBaseline: beforeCustomEngine,
      }),
    );
    try {
      if (mode === "default" || mode === "disabled") {
        const lease = await awaitGateBeforeSettlement(
          pending,
          entered.promise,
          "Default context engine waited for workspace attribution",
        );
        expect(lease.effectiveEngineId).toBe("legacy");
        expect(beforeCustomEngine).not.toHaveBeenCalled();
        expect(factory).not.toHaveBeenCalled();
      } else {
        await awaitGateBeforeSettlement(
          entered.promise,
          pending,
          "Custom factory bypassed attribution",
        );
        expect(factory).not.toHaveBeenCalled();
        if (mode === "rejected") {
          const failure = new Error("workspace attribution failed");
          baseline.reject(failure);
          await expect(pending).rejects.toBe(failure);
          expect(factory).not.toHaveBeenCalled();
          expect(await listContextEngineQuarantines()).toEqual([]);
        } else {
          baseline.resolve();
          expect((await pending).effectiveEngineId).toBe(engineId);
          expect(factory).toHaveBeenCalledOnce();
        }
      }
    } finally {
      baseline.resolve();
      await pending.then(
        (lease) => lease.dispose(),
        () => undefined,
      );
    }
  },
);

it.each([
  ["standalone", "missing"],
  ["standalone", "factory"],
  ["logical-turn", "missing"],
  ["logical-turn", "factory"],
] as const)("preserves enabled %s %s failure", async (path, failure) => {
  const { registry, factory } = fixture(engineId, failure !== "missing");
  factory.mockImplementation(() => {
    throw new Error("Async work scope is closed");
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  await withPluginRuntimeRegistryScope(registry, async () => {
    const result = await resolve(path, selectedConfig);
    if (path === "logical-turn") {
      expect(result.failure).toContain(
        failure === "missing" ? "not registered" : "Async work scope is closed",
      );
    } else {
      expect(result.id).toBe("legacy");
      expect(await listContextEngineQuarantines()).toEqual([
        expect.objectContaining({
          engineId,
          operation: failure === "missing" ? "resolve" : "factory",
        }),
      ]);
      if (failure === "factory") {
        expect((await resolve(path, selectedConfig)).id).toBe("legacy");
        expect(factory).toHaveBeenCalledOnce();
      }
    }
  });
});

it.each([
  ["standalone", ownerId],
  ["standalone", engineId],
  ["logical-turn", ownerId],
  ["logical-turn", engineId],
] as const)(
  "%s disables then re-enables owner %s without clearing its engine slot or registering again",
  async (path, owner) => {
    const { registry, factory } = fixture(owner);
    const disabled = setPluginEnabledInConfig(selectedConfig, owner, false);
    await withPluginRuntimeRegistryScope(registry, async () => {
      expect(await resolve(path, disabled)).toEqual(legacySelection);
      expect(factory).not.toHaveBeenCalled();
      expect(await resolve(path, setPluginEnabledInConfig(disabled, owner, true))).toEqual({
        id: engineId,
        owner,
        failure: undefined,
      });
      expect(await listContextEngineQuarantines()).toEqual([]);
    });
    expect(disabled.plugins?.slots?.contextEngine).toBe(engineId);
    expect(factory).toHaveBeenCalledOnce();
  },
);

it.each(["standalone", "logical-turn"] as const)(
  "%s enforces owner approval independently of the engine ID",
  async (path) => {
    for (const policy of [
      {},
      { allow: [engineId] },
      { allow: [engineId], entries: { [ownerId]: { enabled: true } } },
    ]) {
      const { registry, factory } = fixture(ownerId);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      await withPluginRuntimeRegistryScope(registry, async () => {
        expect(
          await resolve(path, { plugins: { ...policy, slots: { contextEngine: engineId } } }),
        ).toEqual({ id: "legacy", owner: undefined, failure: undefined });
        expect(await listContextEngineQuarantines()).toEqual([]);
      });
      expect(factory).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      warn.mockRestore();
      error.mockRestore();
    }
  },
);

it.each(["standalone", "logical-turn"] as const)(
  "%s selects an exact engine ID through its independently allowlisted owner",
  async (path) => {
    const selectedId = "Synthetic-Engine";
    const { registry, factory } = fixture(ownerId, true, selectedId);
    await withPluginRuntimeRegistryScope(registry, async () => {
      expect(
        await resolve(path, {
          plugins: { allow: [ownerId], slots: { contextEngine: selectedId } },
        }),
      ).toEqual({ id: selectedId, owner: ownerId, failure: undefined });
      expect(await listContextEngineQuarantines()).toEqual([]);
    });
    expect(factory).toHaveBeenCalledOnce();
  },
);

it.each(["standalone", "logical-turn"] as const)(
  "%s keeps equal-ID selection outside an unrelated allowlist",
  async (path) => {
    const { registry, factory } = fixture();
    await withPluginRuntimeRegistryScope(registry, async () => {
      expect(
        await resolve(path, {
          plugins: { allow: ["unrelated"], slots: { contextEngine: engineId } },
        }),
      ).toEqual({ id: engineId, owner: engineId, failure: undefined });
      expect(await listContextEngineQuarantines()).toEqual([]);
    });
    expect(factory).toHaveBeenCalledOnce();
  },
);

it("plugin disable produces ordinary logical turns without registration or degradation warnings", async () => {
  const { registry, factory } = fixture(engineId, false);
  const config = setPluginEnabledInConfig(selectedConfig, engineId, false);
  using warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await withPluginRuntimeRegistryScope(registry, async () => {
    for (const runId of ["first", "second"]) {
      const lease = await createContextEngineLogicalTurnLease({
        config,
        identity: { runId, sessionId: "synthetic-session" },
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
    expect(await listContextEngineQuarantines()).toEqual([]);
  });
  expect(factory).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
});
