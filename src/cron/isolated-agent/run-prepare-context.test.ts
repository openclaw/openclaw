import { expect, it, vi } from "vitest";
import { createModelRuntimeChoiceOwnerFixture } from "../../agents/model-runtime-choice.test-support.js";
import {
  createPreparedModelRuntimeLease,
  ownPreparedPluginGeneration,
} from "../../agents/prepared-model-runtime.plugin-lifetime.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import { createTestPluginRegistry } from "../../plugins/registry-runtime.test-helpers.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import type { SessionEffectRef } from "../../sessions/session-controller.contracts.js";
import {
  beginSessionEffect,
  captureSessionTarget,
} from "../../sessions/session-controller.lifecycle.js";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { prepareCronRunContext } from "./run-prepare-context.js";

const { resolvePreparation } = vi.hoisted(() => ({ resolvePreparation: vi.fn() }));
// mock-isolation: Supply completed preparation; real lease disposal and session admission own the assertion.
vi.mock("./run-prepare.js", () => ({ resolveCronRunPreparation: resolvePreparation }));
// mock-isolation: Continuation deletion is external I/O; admission and resource release stay real.
vi.mock("../run-continuation-cleanup.js", () => ({
  removeCronRunContinuationSessionIfIdle: vi.fn(async () => {}),
}));

it("releases the selected plugin generation when cancelled before session execution", async () => {
  const controller = new AbortController();
  const cancelled = new Error("cancel prepared cron before execution");
  const { registry } = createTestPluginRegistry();
  const record = createPluginRecord({ id: "cron-runtime", status: "loaded" });
  registry.plugins.push(record);
  const instance = new PluginInstance(record.id, { record, registry });
  const snapshot = createModelRuntimeChoiceOwnerFixture({}, () => true, {
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
  const sessionKey = "agent:main:cron:cancelled";
  const storePath = "/tmp/cron-lease-owner/openclaw-agent.sqlite";
  let sessionPreparationEffect: SessionEffectRef | undefined;
  resolvePreparation.mockResolvedValue({
    ok: true,
    resources: new AsyncDisposableStack(),
    admission: {
      agentId: "main",
      sessionKey,
      storePath,
      signal: controller.signal,
      onInterrupt: () => {},
    },
    prepare: async () => {
      sessionPreparationEffect = await beginSessionEffect({
        target: captureSessionTarget({ storeScope: storePath, sessionKey }),
        signal: controller.signal,
      });
      expect(instance.retainedWorkCount).toBe(1);
      controller.abort(cancelled);
      return {
        ok: true,
        context: {
          preparedModelRuntimeLease: lease,
          sessionPreparationEffect,
          runContinuationSession: {},
          runSessionKey: sessionKey,
          runSessionId: "prepared-run",
          cronSession: { storePath },
        },
      };
    },
  });
  const runPrepared = vi.fn();
  try {
    await expect(
      prepareCronRunContext({
        input: makeIsolatedAgentParamsFixture(),
        isFastTestEnv: true,
        onLifecycleInterrupt: () => {},
        runPrepared,
      }),
    ).rejects.toThrow(cancelled);
    expect(runPrepared).not.toHaveBeenCalled();
    expect(instance.retainedWorkCount).toBe(0);
  } finally {
    sessionPreparationEffect?.release();
    await lease[Symbol.asyncDispose]();
    await releasePublication();
  }
});
