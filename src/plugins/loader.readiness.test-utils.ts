// Imported by loader.test.ts so this proof uses the production plugin-loader module graph.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginReadinessResolver } from "../readiness/plugin-readiness.js";
import { createDeferredCore } from "../shared/deferred.js";
import { useNoBundledPlugins, writePlugin } from "./loader.test-fixtures.js";
import { loadRegistryFromSinglePlugin } from "./loader.test-harness.js";
import type { OpenClawPluginReadinessCriterion } from "./types.js";

type Check = OpenClawPluginReadinessCriterion["check"];
type CheckResult = Awaited<ReturnType<Check>>;

describe("plugin readiness loader replacement", () => {
  it("quarantines an abort-ignoring callback across loaded registry generations", async () => {
    useNoBundledPlugins();
    const retired = createDeferredCore<CheckResult>();
    let retiredSignal: AbortSignal | undefined;
    let active = 0;
    let maxActive = 0;
    const retiredCheck = vi.fn<Check>(async ({ signal }) => {
      retiredSignal = signal;
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        return await retired.promise;
      } finally {
        active -= 1;
      }
    });
    const replacementCheck = vi.fn<Check>(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        return {
          status: "False",
          reason: "ReplacementUnavailable",
          message: "Replacement storage is unavailable.",
        };
      } finally {
        active -= 1;
      }
    });
    const fixtureState = globalThis as typeof globalThis & {
      readinessLoaderChecks?: Check[];
    };
    fixtureState.readinessLoaderChecks = [retiredCheck, replacementCheck];
    const plugin = writePlugin({
      id: "readiness-loader",
      filename: "readiness-loader.cjs",
      body: `module.exports = {
        id: "readiness-loader",
        register(api) {
          const check = globalThis.readinessLoaderChecks.shift();
          if (!check) throw new Error("missing readiness loader check");
          api.registerReadinessCriterion({
            id: "backend",
            description: "Storage availability.",
            check,
          });
        },
      };`,
    });
    const load = () =>
      loadRegistryFromSinglePlugin({
        plugin,
        pluginConfig: { allow: ["readiness-loader"] },
        options: { onlyPluginIds: ["readiness-loader"] },
      });
    const config: OpenClawConfig = {
      gateway: { readiness: { requiredCriteria: ["plugin.readiness-loader.backend"] } },
    };
    const resolve = createPluginReadinessResolver({ cacheTtlMs: 60_000 });

    try {
      const firstRegistry = load();
      const first = resolve({ registry: firstRegistry, config });
      await vi.waitFor(() => expect(retiredSignal).toBeDefined());
      expect(active).toBe(1);

      const replacementRegistry = load();
      expect(replacementRegistry).not.toBe(firstRegistry);
      const pending = await resolve({
        registry: replacementRegistry,
        config: structuredClone(config),
      });
      expect(retiredSignal?.aborted).toBe(true);
      expect(pending.conditions).toContainEqual(
        expect.objectContaining({
          type: "plugin.readiness-loader.backend",
          status: "Unknown",
          reason: "CriterionPreviousEvaluationPending",
        }),
      );
      expect(replacementCheck).not.toHaveBeenCalled();
      expect(maxActive).toBe(1);

      retired.resolve({
        status: "True",
        reason: "RetiredReady",
        message: "Retired storage is ready.",
      });
      await first;
      const current = await resolve({
        registry: replacementRegistry,
        config: structuredClone(config),
      });
      expect(current.conditions).toContainEqual(
        expect.objectContaining({
          type: "plugin.readiness-loader.backend",
          status: "False",
          reason: "ReplacementUnavailable",
        }),
      );
      expect(replacementCheck).toHaveBeenCalledTimes(1);
      expect(maxActive).toBe(1);
    } finally {
      retired.resolve({
        status: "True",
        reason: "RetiredReady",
        message: "Retired storage is ready.",
      });
      delete fixtureState.readinessLoaderChecks;
    }
  });
});
