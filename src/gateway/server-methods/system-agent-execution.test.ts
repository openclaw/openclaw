import { afterEach, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  getPreparedModelRuntimePluginGeneration,
  withPreparedModelRuntimePluginGenerationScope,
} from "../../agents/prepared-model-runtime-generation-scope.js";
import type { PreparedModelRuntimePluginGeneration } from "../../agents/prepared-model-runtime.types.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { createEmptyPluginMetadataSnapshot } from "../../plugins/plugin-metadata-empty.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { getPluginRegistryForContext } from "../../plugins/runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { runSystemAgentGatewayTask } from "./system-agent-execution.js";

afterEach(() => {
  resetCommandQueueStateForTest();
  resetPluginRuntimeStateForTest();
});

it("selects the current runtime for independent queued work while retaining its caller fences", async () => {
  const oldRegistry = createEmptyPluginRegistry();
  const replacementRegistry = createEmptyPluginRegistry();
  const generation: PreparedModelRuntimePluginGeneration = {
    remoteCatalog: null,
    pluginMetadataSnapshot: createEmptyPluginMetadataSnapshot(),
    inlineProviderModels: [],
    configuredCatalogEntries: [],
  };
  const approvalController = new AbortController();
  const caller = {
    agentId: "main",
    sessionKey: "agent:main:queue-owner",
    approvalSignals: [approvalController.signal],
    approvalAuthorityCheck: () => !approvalController.signal.aborted,
  };
  setActivePluginRegistry(oldRegistry);
  const started = createDeferred();
  const release = createDeferred();
  const blocker = runSystemAgentGatewayTask(async () => {
    started.resolve();
    await release.promise;
  });
  await started.promise;
  const queued = withGatewayToolCallerIdentity(caller, () =>
    withPreparedModelRuntimePluginGenerationScope(generation, () =>
      withPluginRuntimeGenerationScope(
        { metadataSnapshot: generation.pluginMetadataSnapshot, pluginRegistry: oldRegistry },
        async () => {
          await runSystemAgentGatewayTask(async () => {
            expect(getGatewayToolCallerIdentity()).toMatchObject(caller);
            expect(getGatewayToolCallerIdentity()?.approvalAuthorityCheck?.()).toBe(true);
            expect(getPluginRegistryForContext()).toBe(replacementRegistry);
            expect(getPreparedModelRuntimePluginGeneration()).toBeUndefined();
          });
          expect(getPluginRegistryForContext()).toBe(oldRegistry);
          expect(getPreparedModelRuntimePluginGeneration()).toBe(generation);
        },
      ),
    ),
  );
  try {
    setActivePluginRegistry(replacementRegistry);
    release.resolve();
    await Promise.all([blocker, queued]);
  } finally {
    release.resolve();
    await Promise.allSettled([blocker, queued]);
  }
});

it("propagates queued failures and retains revoked caller fences for subsequent tasks", async () => {
  const controller = new AbortController();
  const failure = new Error("synthetic queued task failure");
  await expect(
    runSystemAgentGatewayTask(async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  controller.abort();
  await withGatewayToolCallerIdentity(
    {
      agentId: "main",
      sessionKey: "agent:main:revoked",
      approvalSignals: [controller.signal],
      approvalAuthorityCheck: () => !controller.signal.aborted,
    },
    () =>
      runSystemAgentGatewayTask(async () => {
        const caller = getGatewayToolCallerIdentity();
        expect(caller?.approvalSignals).toEqual([controller.signal]);
        expect(caller?.approvalAuthorityCheck?.()).toBe(false);
        return "settled";
      }),
  );
});
