import { vi } from "vitest";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { observeMediaGenerationSettlement } from "../media-generation-activity.observer.test-support.js";
import {
  admitMediaHandle,
  resetGeneratedMediaTaskActivityForTests,
} from "../media-generation-activity.test-support.js";
import { prepareConfiguredRuntimeFacts } from "../prepared-model-runtime.configured-catalog.js";
import type { prepareWorkspaceBuildGroup } from "../prepared-model-runtime.facts.js";
import { createPreparedModelRuntimeSnapshot } from "../prepared-model-runtime.full-catalog.js";
import { ModelRegistry } from "../sessions/model-registry.js";
import type { imageGenerationTaskLifecycle } from "./media-generate-background.js";

export function reset() {
  vi.restoreAllMocks();
  resetGeneratedMediaTaskActivityForTests();
  clearPluginMetadataLifecycleCaches();
}

export function snapshot(
  prepared: Awaited<ReturnType<typeof prepareWorkspaceBuildGroup>>,
  loadAuth = async (): Promise<never> => {
    throw new Error("No model auth in this fixture");
  },
) {
  const facts = prepared.agentFacts[0]!;
  const catalog = prepareConfiguredRuntimeFacts({
    agentFacts: facts,
    workspaceFacts: prepared.pluginGeneration,
    templateModelRegistry: ModelRegistry.inMemory(facts.templateAuthStorage),
    configuredRuntimeModels: facts.configuredRuntimeModels,
  });
  return createPreparedModelRuntimeSnapshot(undefined, facts, prepared.pluginGeneration, catalog, {
    initialAuth: { authStore: facts.authStore, authModes: {}, providerAuthLabels: new Map() },
    readUsage: (store) => store,
    isCurrent: () => true,
    withRefreshStatus: (value) => value,
    readFullModelCatalog: () => catalog.modelCatalog,
    refreshExpiredModelCatalog: () => {},
    recheckNativeLogin: () => {},
    readPublishedModels: () => undefined,
    loadFullModelCatalog: async () => catalog.modelCatalog,
    loadNativeModelCatalog: async () => catalog.modelCatalog,
    loadAuth,
  });
}

export function admitTask(
  lifecycle: typeof imageGenerationTaskLifecycle,
  requesterSessionKey: string,
) {
  let admitted = 0;
  const created = vi.spyOn(lifecycle, "createTaskRun").mockImplementation(async () =>
    admitMediaHandle({
      taskId: `resource-task-${++admitted}`,
      runId: `resource-run-${admitted}`,
      detach: true,
      requesterSessionKey,
      requesterAgentId: "main",
      taskLabel: "Synthetic resource proof",
    }),
  );
  const completeTaskRun = lifecycle.completeTaskRun.bind(lifecycle);
  const failTaskRun = lifecycle.failTaskRun.bind(lifecycle);
  const completed = vi.spyOn(lifecycle, "completeTaskRun").mockImplementation(completeTaskRun);
  const failed = vi.spyOn(lifecycle, "failTaskRun").mockImplementation(failTaskRun);
  const settlement = observeMediaGenerationSettlement({
    completeOperation: completed,
    failOperation: failed,
  });
  const wake = vi.spyOn(lifecycle, "wakeTaskCompletion").mockResolvedValue({ status: "delivered" });
  return { created, completed, failed, wake, settlement };
}
