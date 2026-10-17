import { vi } from "vitest";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  admitMediaHandle,
  resetGeneratedMediaTaskActivityForTests,
} from "../media-generation-activity.test-support.js";
import { resetRecentMediaGenerationDuplicateGuardsForTests } from "../media-generation-task-status-shared.test-support.js";
import { prepareConfiguredRuntimeFacts } from "../prepared-model-runtime.configured-catalog.js";
import type { prepareWorkspaceBuildGroup } from "../prepared-model-runtime.facts.js";
import { createPreparedModelRuntimeSnapshot } from "../prepared-model-runtime.full-catalog.js";
import { ModelRegistry } from "../sessions/model-registry.js";
import type { imageGenerationTaskLifecycle } from "./media-generate-background.js";

export function phase() {
  const entered = createDeferredCore();
  const released = createDeferredCore();
  return {
    entered: entered.promise,
    release: () => released.resolve(),
    pause: async () => {
      entered.resolve();
      await released.promise;
    },
  };
}

export function waitForPhase(entered: Promise<unknown>, work: Promise<unknown>) {
  return Promise.race([
    entered,
    work.then(() => {
      throw new Error("Media work settled before the expected phase");
    }),
  ]);
}

export function reset() {
  vi.restoreAllMocks();
  resetRecentMediaGenerationDuplicateGuardsForTests();
  resetGeneratedMediaTaskActivityForTests();
  clearPluginMetadataLifecycleCaches();
}

export function snapshot(prepared: Awaited<ReturnType<typeof prepareWorkspaceBuildGroup>>) {
  const facts = prepared.agentFacts[0]!;
  const catalog = prepareConfiguredRuntimeFacts({
    agentFacts: facts,
    workspaceFacts: prepared.pluginGeneration,
    templateModelRegistry: ModelRegistry.inMemory(facts.templateAuthStorage),
    configuredRuntimeModels: facts.configuredRuntimeModels,
  });
  return createPreparedModelRuntimeSnapshot(undefined, facts, prepared.pluginGeneration, catalog, {
    initialAuth: { authStore: facts.authStore, authModes: {}, providerAuthLabels: new Map() },
    isCurrent: () => true,
    withRefreshStatus: (value) => value,
    readFullModelCatalog: () => catalog.modelCatalog,
    refreshExpiredModelCatalog: () => {},
    recheckNativeLogin: () => {},
    readPublishedModels: () => undefined,
    loadFullModelCatalog: async () => catalog.modelCatalog,
    loadNativeModelCatalog: async () => catalog.modelCatalog,
    loadAuth: async () => {
      throw new Error("No model auth in this fixture");
    },
  });
}

export function admitTask(
  lifecycle: typeof imageGenerationTaskLifecycle,
  requesterSessionKey: string,
) {
  vi.spyOn(lifecycle, "createTaskRun").mockImplementation(async () =>
    admitMediaHandle({
      taskId: "resource-task",
      runId: "resource-run",
      detach: true,
      requesterSessionKey,
      requesterAgentId: "main",
      taskLabel: "Synthetic resource proof",
    }),
  );
  vi.spyOn(lifecycle, "recordTaskProgress").mockImplementation(() => {});
  const completed = vi.spyOn(lifecycle, "completeTaskRun").mockImplementation(() => {});
  const failed = vi.spyOn(lifecycle, "failTaskRun").mockImplementation(() => {});
  vi.spyOn(lifecycle, "wakeTaskCompletion").mockResolvedValue({ status: "delivered" });
  return { completed, failed };
}
