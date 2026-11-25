// Preserve prepared-runtime module setup before its consumers.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "../agents/prepared-model-runtime.test-harness.js";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { refreshPreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOwnedInstance } from "../plugins/plugin-instance.test-support.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { buildGatewayReloadPlan } from "./config-reload-plan.js";
import { respondUnavailableOnThrow } from "./server-methods/response.js";
import { sessionByKeyReadHandlers } from "./server-methods/sessions-read-by-key.js";
import { requestContext } from "./server-methods/sessions-read-cache.test-support.js";
import { readPreparedGatewayModelCatalog } from "./server-model-catalog.js";
import { createHotReloadHandlerTestParams } from "./server-reload-handlers.config.test-support.js";
import { createGatewayReloadHandlers } from "./server-reload-hot.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import {
  createTestProjection,
  holdForeground,
  seedRow,
  watchRowFacts,
  waitForRead,
} from "./session-row-projection.read-fixture.test-support.js";
import { requestSessionRow } from "./session-row-projection.test-support.js";

const fixture = usePreparedModelRuntimeHarness(
  { label: "describe-config-reload" },
  clearRuntimeConfigSnapshot,
);
afterEach(() => vi.restoreAllMocks());

it.for(["logging.level", "models.providers.other.baseUrl"] as const)(
  "describes a session across unrelated %s hot reload during row preparation",
  async (changedPath, { signal }) => {
    const { mocks } = fixture;
    mocks.configuredAgentIds = ["main"];
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} }, defaults: { model: "fixture-provider/reasoner" } },
      models: { providers: { other: { baseUrl: "https://before.example/v1", models: [] } } },
    };
    const next: OpenClawConfig =
      changedPath === "logging.level"
        ? { ...cfg, logging: { level: "debug" } }
        : {
            ...cfg,
            models: { providers: { other: { baseUrl: "https://after.example/v1", models: [] } } },
          };
    Object.assign(
      mocks.pluginMetadataSnapshot,
      createPluginMetadataSnapshotFixture({
        plugins: [{ id: "fixture-provider", providers: ["fixture-provider"] }],
      }),
    );
    const providers: ReturnType<typeof createOwnedInstance>[] = [];
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(() => {
      const owned = createOwnedInstance("fixture-provider", "bundled");
      providers.push(owned);
      owned.registry.providers.push({
        pluginId: "fixture-provider",
        source: "/synthetic/provider.js",
        provider: owned.instance.wrap({
          id: "fixture-provider",
          label: "Fixture",
          auth: [],
          resolveThinkingProfile: () => ({
            levels: [{ id: "off" as const }, { id: "high" as const }],
            defaultLevel: "high" as const,
          }),
        }),
      });
      return owned.registry;
    });
    const entries = [
      { id: "reasoner", name: "Reasoner", provider: "fixture-provider", reasoning: true },
    ];
    mocks.buildPreparedModelCatalogSnapshot.mockImplementation(async () => ({
      entries,
      routeVariants: entries,
    }));
    setRuntimeConfigSnapshot(cfg, cfg);
    await refreshPreparedModelRuntimeSnapshots(cfg, {
      gatewayLifecycle: true,
      catalogMode: "static",
      allowGatewaySubagentBinding: true,
    });
    const getConfig = () => expectDefined(getRuntimeConfigSnapshot(), "published config");
    using _ = holdForeground();
    using projection = await createTestProjection({
      cfg,
      getConfig,
      getModelCatalog: async () =>
        new Map([["main", await readPreparedGatewayModelCatalog({ agentId: "main", getConfig })]]),
    });
    const context = bindSessionRowProjection(requestContext(cfg), () => projection);
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    watchRowFacts((owner) => async (...args) => {
      entered.resolve();
      await resume.promise;
      return owner.readRowFacts(...args);
    });
    const key = "agent:main:config-reload";
    seedRow(key, {
      sessionId: "config-reload",
      updatedAt: 1,
      providerOverride: "fixture-provider",
      modelOverride: "reasoner",
    });
    sessionChanges.emit({ sessionKey: key, agentId: "main", factsInvalidated: true });
    const respond = vi.fn();
    const pending = respondUnavailableOnThrow(respond, async () => {
      await requestSessionRow(
        sessionByKeyReadHandlers["sessions.describe"]!,
        context,
        "sessions.describe",
        { key },
        respond,
        null,
      );
    });
    void pending.catch(() => {});
    const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
    const handler = createGatewayReloadHandlers(
      createHotReloadHandlerTestParams({
        scheduler: createTestGatewayScheduler(),
        deps: {},
        getPluginRegistry: () => expectDefined(providers[0], "initial provider").registry,
        requestRecoveryRestart,
        reloadPlugins: async () => {
          throw new Error("Unrelated config must not reload Gateway plugins");
        },
      }),
    );
    try {
      await waitForRead(
        entered.promise,
        pending,
        signal,
        "describe finished before row preparation",
      );
      await handler.applyHotReload(buildGatewayReloadPlan([changedPath]), next, {
        sourceConfig: next,
        isCurrent: () => true,
        publish: async (commit) => {
          setRuntimeConfigSnapshot(next, next);
          await commit();
        },
      });
      resume.resolve();
      await withinTest(pending, signal);
      expect(respond).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0]).toMatchObject([
        true,
        { session: { sessionId: "config-reload", thinkingDefault: "high" } },
      ]);
      expect(getRuntimeConfigSnapshot()).toBe(next);
      expect(requestRecoveryRestart).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      await pending.catch(() => {});
      handler.stopRestartRetries();
      await Promise.all(providers.map(({ instance }) => instance.dispose()));
    }
  },
);
