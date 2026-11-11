import { afterEach, expect, it, vi } from "vitest";
import { resolveProviderIdForAuth } from "../agents/provider-auth-aliases.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { getPluginCache } from "../plugins/plugin-cache.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import * as pluginMetadata from "../plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as cronRuntime from "./server-cron.js";
import {
  createDefaultGatewayReloadState,
  createHotReloadHandlerTestParams,
  createHotTailPlan,
  createTestCronState,
  makePluginReloadResult,
} from "./server-reload-handlers.config.test-support.js";
import { createGatewayReloadHandlers } from "./server-reload-hot.js";

const registry = createEmptyPluginRegistry();
afterEach(() => {
  clearRuntimeConfigSnapshot();
  clearCurrentPluginMetadataSnapshot();
  resetPluginRuntimeStateForTest();
});

it.each(["on", "off", "superseded"])("accepted cron state: %s", async (mode) => {
  setActivePluginRegistry(registry);
  using loadMetadata = vi.spyOn(pluginMetadata, "loadPluginMetadataSnapshot");
  await withOpenClawTestState({ label: "post-commit-plugin-metadata" }, async () => {
    const owner = "memory-owner";
    const dreaming = { enabled: mode === "on" };
    const entries = { [owner]: { enabled: true, config: { dreaming } } };
    const config = { plugins: { slots: { memory: owner }, entries } };
    setRuntimeConfigSnapshot(config);
    const metadata = createPluginMetadataSnapshotFixture({
      plugins: [
        { id: "fixture", providerAuthAliases: { "fixture-alias": "fixture" } },
        { id: owner, kind: "memory" },
        { id: "memory-core", kind: "memory" },
      ],
    });
    setGatewayPluginMetadataSnapshot(metadata, { config });
    const resolvedProviders: string[] = [];
    const committed: string[] = [];
    const cronState = createTestCronState();
    cronState.cron.start = vi.fn(async () => {
      resolvedProviders.push(resolveProviderIdForAuth("fixture-alias", { config }));
    });
    cronState.cron.list = vi.fn(async () => [
      makeCronJob({ id: "canonical", declarationKey: "memory-core:memory-dreaming-promotion" }),
      makeCronJob({ id: "lookalike", name: "Memory Dreaming Promotion" }),
    ]);
    cronState.cron.remove = vi.fn<typeof cronState.cron.remove>(async (id, options) => {
      if (mode === "superseded") {
        setRuntimeConfigSnapshot({});
      }
      options?.commitGuard?.();
      committed.push(id);
      return { ok: true, removed: true };
    });
    using _ = vi.spyOn(cronRuntime, "buildGatewayCronService").mockReturnValue(cronState);
    const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
    const handlers = createGatewayReloadHandlers(
      createHotReloadHandlerTestParams(
        {
          scheduler: createTestGatewayScheduler("fake-timers"),
          getPluginRegistry: () => registry,
          getPluginMetadataSnapshot: () => metadata,
          deps: {} as never,
          reloadPlugins: vi.fn(async ({ commitRuntime }) => {
            await commitRuntime();
            return makePluginReloadResult();
          }),
          requestRecoveryRestart,
        },
        createDefaultGatewayReloadState({ cronState }),
      ),
    );
    let commitCacheKind: string | undefined;
    await withPluginLifecycleLease({}, () =>
      handlers.applyHotReload(
        createHotTailPlan({ restartCron: true, reloadPlugins: true }),
        config,
        {
          sourceConfig: config,
          isCurrent: () => true,
          publish: async (commit) => {
            commitCacheKind = getPluginCache().kind;
            await commit();
          },
        },
      ),
    );
    expect(committed).toEqual(mode === "off" ? ["canonical"] : []);
    expect(commitCacheKind).toBe("operation");
    expect(resolvedProviders).toEqual(["fixture"]);
    expect(loadMetadata).not.toHaveBeenCalled();
    expect(requestRecoveryRestart).not.toHaveBeenCalled();
  });
});
