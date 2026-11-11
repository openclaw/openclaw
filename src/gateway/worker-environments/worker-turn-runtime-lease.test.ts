// Preserve lifecycle fixture mocks before consumers of the prepared runtime.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "../../agents/prepared-model-runtime.test-harness.js";
import { beforeEach, expect, it, vi } from "vitest";
import { scopePreparedModelRuntimeLease } from "../../agents/prepared-model-runtime-generation-scope.js";
import {
  acquireAgentRunPreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime,
  refreshPreparedModelRuntimeSnapshots,
} from "../../agents/prepared-model-runtime.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../../config/plugin-auto-enable.test-helpers.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import {
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  placements,
  seedActivePlacement,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
} from "./worker-turn-launcher.test-support.js";
const fixture = usePreparedModelRuntimeHarness({ label: "worker-turn-runtime-lease" }, () =>
  cleanupWorkerTurnLauncherTest(),
);
beforeEach(setupWorkerTurnLauncherTest);
it("reacquires a selected provider lease through the admitted device-worker turn", async () => {
  await seedActivePlacement();
  const input = turn("selected-provider-worker");
  const config = {
    ...input.config,
    agents: { defaults: { model: "custom/model", workspace: fixture.state.workspaceDir } },
  };
  fixture.mocks.configuredAgentIds = ["main"];
  fixture.mocks.configuredWorkspaces.set("main", fixture.state.workspaceDir);
  const selectedRegistry = createEmptyPluginRegistry();
  selectedRegistry.plugins.push(
    createPluginRecord({
      id: "selected-provider",
      origin: "bundled",
      imported: true,
    }),
  );
  selectedRegistry.providers.push({
    pluginId: "selected-provider",
    source: "test",
    provider: { id: "selected", label: "Selected fixture", auth: [] },
  });
  fixture.mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation((params) =>
    params.selections?.some((selection: { provider: string }) => selection.provider === "selected")
      ? selectedRegistry
      : createEmptyPluginRegistry(),
  );
  const metadata = createPluginMetadataSnapshot({
    config,
    manifestRegistry: makeRegistry([
      { id: "selected-provider", origin: "bundled", channels: [], providers: ["selected"] },
    ]),
  });
  await refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
    pluginMetadataSnapshot: {
      ...metadata,
      owners: { ...metadata.owners, providers: new Map([["selected", ["selected-provider"]]]) },
    },
  });
  const published = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "main" });
  expect(published).toBeDefined();
  if (!published) {
    throw new Error("missing configured Gateway publication");
  }
  // A worktree uses a different workspace; using the configured workspace here
  // would take the borrowed-lease fast path and hide the missing selection.
  await using admitted = scopePreparedModelRuntimeLease(
    await acquireAgentRunPreparedModelRuntime(
      {
        config,
        agentId: "main",
        agentDir: published.agentDir,
        workspaceDir: published.workspaceDir,
        runtimePluginSelections: [{ provider: "selected", modelId: "model", runtime: "openclaw" }],
      },
      { pluginGeneration: published.pluginGeneration, catalogMode: "static" },
    ),
  );
  expect(admitted.pluginGeneration).not.toBe(published.pluginGeneration);
  expect(admitted.snapshot.pluginRegistry).toBe(selectedRegistry);
  const stop = new Error("fixture reached worker execution after runtime acquisition");
  const onExecutionStarted = vi.fn(async () => {
    throw stop;
  });
  const environments = {
    ...unusedEnvironments(),
    get: () => ({ ...attachedEnvironment(), providerId: "device", nodeDeviceId: "fixture-node" }),
  };
  const worker = createWorkerSessionTurnPlacementProvider({ placements, environments });
  try {
    await admitted.run(async () => {
      // Stop before provider inference or transport: this proves the real worker's
      // re-acquisition, not a helper that can omit its runtime selection.
      await expect(
        worker.executeTurn(
          { ...sessionTarget, runId: input.runId },
          {
            ...input,
            config,
            provider: "selected",
            model: "model",
            agentDir: published.agentDir,
            pluginGeneration: admitted.pluginGeneration,
            onExecutionStarted,
          },
          vi.fn(),
        ),
      ).rejects.toThrow(stop.message);
    });
    expect(onExecutionStarted).toHaveBeenCalledOnce();
    expect(environments.startTunnel).not.toHaveBeenCalled();
  } finally {
    input.preparedRunAdmission.close();
  }
});
