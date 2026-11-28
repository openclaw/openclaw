import fs from "node:fs";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { configFor } from "../agents/model-auth.fixtures.test-support.js";
import {
  acquireAgentRunPreparedModelRuntime,
  refreshPreparedModelRuntimeSnapshots,
} from "../agents/prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import {
  completionChunk,
  completionModelDefinition,
  startCompletionServer,
} from "../agents/simple-completion.test-support.js";
import * as utilityCompletion from "../agents/utility-completion.js";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  loadSessionEntryReadOnly,
  readSessionTranscriptWatermark,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import * as pluginCaches from "../plugins/plugin-cache.js";
import { createOwnedTestInstance } from "../plugins/plugin-instance.test-support.js";
import { PluginInvocationScope } from "../plugins/plugin-invocation-scope.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import {
  createColdPluginConfig,
  createColdPluginFixture,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { createSyncSuiteTempRootTracker } from "../plugins/test-helpers/fs-fixtures.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { dispatchGatewayRequestInProcessRaw } from "./server-in-process-dispatch.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { createSessionActivitySummaries } from "./session-activity-summaries.js";
import {
  activityRecapResult,
  createActivityRecapSessionFixture,
  messages,
  preparedActivityRecapModel,
  scope,
  target,
  terminal,
} from "./session-activity-summaries.test-support.js";
import { projectSessionActivitySummary } from "./session-activity-summary-state.js";
import * as observerModel from "./session-observer-model.js";

it("finishes an archive recap after the calling plugin scope closes", async ({ signal }) => {
  const cfg = { agents: { defaults: { utilityModel: "test/utility" } } };
  const state = await createActivityRecapSessionFixture(cfg);
  const connectionWork = new AsyncWorkScope();
  const service = createSessionActivitySummaries({
    scheduler: createTestGatewayScheduler(),
    getConfig: () => cfg,
    onChanged: () => {},
  });
  const context = createGatewayRequestContext(
    makeContextParams({ connectionWork, sessionActivitySummaries: service }),
  );
  const plugin = createOwnedTestInstance("archive-caller");
  const caller = new PluginInvocationScope(plugin.owner!.registry!, [plugin]);
  const started = createDeferred();
  const resume = createDeferred();
  vi.spyOn(utilityCompletion, "hasAvailableUtilityCompletionAuth").mockResolvedValue(true);
  const prepare = vi
    .spyOn(observerModel, "defaultPrepareModel")
    .mockResolvedValue(preparedActivityRecapModel);
  vi.spyOn(observerModel, "defaultCompleteModel").mockResolvedValue(
    activityRecapResult("Completed the requested work."),
  );
  try {
    await messages(2);
    await connectionWork.track(() => service.ensure(target, loadSessionEntryReadOnly(scope)));
    await connectionWork.runWhenIdle(() => {});
    await messages(2, 2);
    prepare.mockImplementationOnce(async () => {
      started.resolve();
      await withinTest(resume.promise, signal);
      return plugin.wrap(() => preparedActivityRecapModel)();
    });
    const response = await caller.run(() =>
      dispatchGatewayRequestInProcessRaw(
        "sessions.patch",
        { ...target, expectedSessionId: scope.sessionId, archived: true },
        { context, client: createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] }) },
      ),
    );
    expect(response).toMatchObject({ ok: true });
    expect(loadSessionEntryReadOnly(scope)?.archivedAt).toBeDefined();
    await withinTest(started.promise, signal);
    caller.release();
    resume.resolve();
    await connectionWork.runWhenIdle(() => {});
    const entry = loadSessionEntryReadOnly(scope);
    expect(entry?.activitySummary).toMatchObject({
      coveredMessages: 4,
      text: "Completed the requested work.",
    });
    expect(
      projectSessionActivitySummary({
        ...target,
        cfg,
        entry,
        watermark: readSessionTranscriptWatermark(scope),
      })?.state,
    ).toBe("current");
  } finally {
    caller.release();
    resume.resolve();
    await AsyncWorkScope.runWhenAllIdle(
      () => [connectionWork],
      () => connectionWork.drain(),
    );
    await service.dispose();
    await state.cleanup();
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
  }
});

it("recaps a run that ended inside a plugin inventory a reload retired", async () => {
  const roots = createSyncSuiteTempRootTracker("activity-recap-retired-inventory");
  const workspace = fs.realpathSync(roots.makeTempDir());
  const fixture = createColdPluginFixture({ rootDir: roots.makeTempDir() });
  fs.writeFileSync(
    fixture.runtimeSource,
    `module.exports = { id: ${JSON.stringify(fixture.pluginId)}, register(api) {
      api.registerProvider({ id: ${JSON.stringify(fixture.providerId)}, label: "Recap", auth: [] });
    } };`,
  );
  const model = completionModelDefinition();
  let requests = 0;
  await using server = await startCompletionServer((request, response) => {
    request.resume();
    requests++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(completionChunk(`Recap ${requests}.`, model.id));
  });
  const modelRef = `${fixture.providerId}/${model.id}`;
  const cfg: OpenClawConfig = {
    agents: { defaults: { workspace, model: modelRef, utilityModel: modelRef } },
    ...configFor(fixture.providerId, server.baseUrl, {
      api: "openai-completions",
      apiKey: "fixture-key",
      models: [model],
    }),
    plugins: {
      ...createColdPluginConfig(fixture.rootDir, fixture.pluginId).plugins,
      slots: { memory: "none" },
    },
  };
  const state = await createActivityRecapSessionFixture(cfg);
  const env = {
    OPENCLAW_BUNDLED_PLUGINS_DIR: roots.makeTempDir(),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  };
  let current = cfg;
  const connectionWork = new AsyncWorkScope();
  const service = createSessionActivitySummaries({
    scheduler: createTestGatewayScheduler(),
    getConfig: () => current,
    onChanged: () => {},
  });
  try {
    await withEnvAsync(env, async () => {
      const publish = async (config: OpenClawConfig) => {
        const cache = pluginCaches.createPluginCache();
        const metadataScope = { config, workspaceDir: workspace };
        const metadata = pluginCaches.withPluginCache(cache, () =>
          resolvePluginMetadataSnapshot(metadataScope),
        );
        setGatewayPluginMetadataSnapshot(metadata, metadataScope);
        await refreshPreparedModelRuntimeSnapshots(config, {
          gatewayLifecycle: true,
          catalogMode: "static",
        });
        return cache;
      };
      const previousCache = await publish(cfg);
      await messages(2);
      await connectionWork.track(() => service.ensure(target, loadSessionEntryReadOnly(scope)));
      await connectionWork.runWhenIdle(() => {});
      expect(loadSessionEntryReadOnly(scope)?.activitySummary?.text).toBe("Recap 1.");
      const turn = scopePreparedModelRuntimeLease(
        await acquireAgentRunPreparedModelRuntime({
          config: cfg,
          agentId: target.agentId,
          agentDir: state.agentDir(),
          workspaceDir: workspace,
        }),
      );
      await messages(2, 2);
      // A plugin reload replaces the inventory while the run is in flight.
      current = { ...cfg, messages: { responsePrefix: "replacement" } };
      await publish(current);
      const retirement = pluginCaches.retirePluginCache(previousCache);
      // The run-end event arrives inside the run's lease and plugin generation, before retirement.
      await connectionWork.track(() =>
        turn.run(() => withPluginRuntimeGenerationScope(turn.snapshot, () => terminal(service))),
      );
      await turn[Symbol.asyncDispose]();
      await retirement;
      await connectionWork.runWhenIdle(() => {});
    });
    expect({
      text: loadSessionEntryReadOnly(scope)?.activitySummary?.text,
      requests,
    }).toEqual({ text: "Recap 2.", requests: 2 });
  } finally {
    await AsyncWorkScope.runWhenAllIdle(
      () => [connectionWork],
      () => connectionWork.drain(),
    );
    await service.dispose();
    await resetPreparedModelRuntimeSnapshotsForTest();
    clearPluginMetadataLifecycleCaches();
    resetPluginLoaderTestStateForTest();
    await state.cleanup();
    clearRuntimeConfigSnapshot();
    roots.cleanup();
  }
});
