import { expect, it, vi } from "vitest";
import { createModelRuntimeChoiceOwnerFixture } from "../../agents/model-runtime-choice.test-support.js";
import {
  createPreparedModelRuntimeLease,
  ownPreparedPluginGeneration,
} from "../../agents/prepared-model-runtime.plugin-lifetime.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import { createTestPluginRegistry } from "../../plugins/registry-runtime.test-helpers.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { isSessionControllerWorkActive } from "../../sessions/session-controller.lifecycle.js";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  acquirePreparedModelRuntimeMock,
  removeCronRunContinuationSessionIfIdleMock,
} from "./run.test-harness.js";

const { prepareCronRunContext } = await import("./run-prepare.js");
const sessionState = await import("./run-session-state.js");

setupRunCronIsolatedAgentTurnSuite({ fast: true });

it("releases the selected plugin generation when cancelled before session execution", async () => {
  const controller = new AbortController();
  const cancelled = new Error("cancel prepared cron before execution");
  const input = makeIsolatedAgentParamsFixture({ abortSignal: controller.signal });
  const { registry } = createTestPluginRegistry();
  const record = createPluginRecord({ id: "cron-runtime", status: "loaded" });
  registry.plugins.push(record);
  const instance = new PluginInstance(record.id, { record, registry });
  const snapshot = createModelRuntimeChoiceOwnerFixture(input.cfg, () => true, {
    pluginRegistry: registry,
  });
  const generation = {
    pluginRegistry: registry,
    pluginMetadataSnapshot: snapshot.metadataSnapshot,
    remoteCatalog: null,
    inlineProviderModels: [],
    configuredCatalogEntries: [],
  };
  const releasePublication = ownPreparedPluginGeneration(generation).retain();
  const lease = createPreparedModelRuntimeLease(snapshot, generation);
  lease.run(instance.wrap(() => undefined));
  acquirePreparedModelRuntimeMock.mockResolvedValue(lease);

  const continuation = vi.spyOn(sessionState, "createCronRunContinuationSession").mockReturnValue({
    initialize: async () => {
      expect(instance.retainedWorkCount).toBe(1);
      controller.abort(cancelled);
    },
    sync: async () => {},
    seal: async () => {},
    recordScheduledMemoryParent: async () => {},
  });
  const cleanupState: Array<{ admitted: boolean; retainedWork: number }> = [];
  removeCronRunContinuationSessionIfIdleMock.mockImplementation(async (sessionKey) => {
    cleanupState.push({
      admitted: isSessionControllerWorkActive("/tmp/store.json", [sessionKey]),
      retainedWork: instance.retainedWorkCount,
    });
  });
  const runPrepared = vi.fn();
  try {
    await expect(
      prepareCronRunContext({
        input,
        isFastTestEnv: true,
        onLifecycleInterrupt: () => {},
        runPrepared,
      }),
    ).rejects.toThrow(cancelled);
    expect(runPrepared).not.toHaveBeenCalled();
    expect(instance.retainedWorkCount).toBe(0);
    expect(cleanupState).toEqual([{ admitted: false, retainedWork: 1 }]);
  } finally {
    continuation.mockRestore();
    await lease[Symbol.asyncDispose]();
    await releasePublication();
  }
});
