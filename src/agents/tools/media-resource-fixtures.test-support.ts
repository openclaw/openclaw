import { vi } from "vitest";
import { admitMediaHandle } from "../media-generation-activity.test-support.js";
import { prepareConfiguredRuntimeFacts } from "../prepared-model-runtime.configured-catalog.js";
import type { prepareWorkspaceBuildGroup } from "../prepared-model-runtime.facts.js";
import { createPreparedModelRuntimeSnapshot } from "../prepared-model-runtime.full-catalog.js";
import { ModelRegistry } from "../sessions/model-registry.js";
import type { imageGenerationTaskLifecycle } from "./media-generate-background.js";

export function waitForMediaPhase(phase: Promise<unknown>, work: Promise<unknown>) {
  return Promise.race([
    phase,
    work.then(() => {
      throw new Error("Media work settled before the expected phase");
    }),
  ]);
}

export function mediaResourceSnapshot(
  prepared: Awaited<ReturnType<typeof prepareWorkspaceBuildGroup>>,
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

export function mockAdmittedMediaTask(
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
