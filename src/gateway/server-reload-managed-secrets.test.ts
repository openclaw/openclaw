import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { lookupContextTokens, resetContextWindowCacheForTest } from "../agents/context.js";
import { closePreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.lifecycle.js";
import { createModelProviderRouteOverrideResolver } from "../config/model-provider-config.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
} from "../config/runtime-snapshot.js";
import { projectConfigOntoRuntimeSourceSnapshot } from "../config/runtime-source-projection.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { PluginRuntimeApplicationError } from "../plugins/lifecycle.js";
import {
  activateSecretsRuntimeSnapshotStateIfCurrent,
  getActiveSecretsRuntimeSnapshotState,
  getActiveSecretsRuntimeSnapshotRevisionState,
} from "../secrets/runtime-state.js";
import {
  activateSecretsRuntimeSnapshot,
  activateSecretsRuntimeSnapshotWithSource,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshotRevision,
  prepareSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { diffConfigPaths } from "./config-diff.js";
import { buildGatewayReloadPlan } from "./config-reload-plan.js";
import type { GatewayConfigReloadTransactionOwnership } from "./config-reload.js";
import {
  closeTestConfigReloaders,
  createReloaderHarness,
  makeSnapshot,
  makeZeroDebounceHookWrite,
} from "./config-reload.test-support.js";
import { GatewayConfigReloadSupersededError } from "./server-reload-contracts.js";
import { createManagedReloadSecretHandlers } from "./server-reload-managed-secrets.js";
import { SharedGatewaySessionGenerationState } from "./server-shared-auth-generation.js";
import { createRuntimeSecretsActivator } from "./server-startup-config.js";

let finishPendingModelReload: (() => Promise<void>) | undefined;

afterEach(async () => {
  await finishPendingModelReload?.();
  finishPendingModelReload = undefined;
  await closeTestConfigReloaders();
  clearSecretsRuntimeSnapshot();
  resetContextWindowCacheForTest();
  vi.restoreAllMocks();
});

function configPair(runtime: "openclaw" | "codex", contextWindow?: number) {
  const source = {
    agents: { defaults: { models: { "openai/gpt-5.6-luna": { agentRuntime: { id: runtime } } } } },
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          models: [
            {
              id: "gpt-5.6-luna",
              name: "Luna",
              reasoning: true,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              maxTokens: 4096,
              ...(contextWindow === undefined ? {} : { contextWindow }),
            },
          ],
        },
      },
    },
  } satisfies OpenClawConfig;
  const config: OpenClawConfig = structuredClone(source);
  // The loader may seed catalog compatibility; this is not authored request policy.
  config.models!.providers!.openai!.models[0]!.compat = { supportsStore: false };
  return { source, config };
}

const prepare = (config: OpenClawConfig) =>
  prepareSecretsRuntimeSnapshot({
    config,
    includeAuthStoreRefs: false,
    env: {},
  });

function activatorOptions() {
  return {
    logSecrets: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    emitStateEvent: vi.fn(),
    prepareRuntimeSecretsSnapshot: ({ config }: { config: OpenClawConfig }) => prepare(config),
    activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshot,
  };
}

function expectAuthoredSource(source: OpenClawConfig) {
  const config = getRuntimeConfigSnapshot();
  expect(config).not.toBeNull();
  expect(getRuntimeConfigSourceSnapshot()).toEqual(source);
  expect(
    createModelProviderRouteOverrideResolver({
      provider: "openai",
      authoredConfig: projectConfigOntoRuntimeSourceSnapshot(config!),
    })("gpt-5.6-luna"),
  ).toBe("none");
}

async function createReload(
  commit: () => Promise<void>,
  beforePublication?: () => Promise<void>,
  wrapPublicationError?: (error: unknown) => unknown,
  { initial = configPair("openclaw"), next = configPair("codex") } = {},
) {
  activateSecretsRuntimeSnapshotWithSource(await prepare(initial.config), initial.source);
  expectAuthoredSource(initial.source);
  const activateRuntimeSecrets = createRuntimeSecretsActivator(activatorOptions());
  // Only secret publication is exercised here; the service tail is injected at its existing seam.
  const params = {
    activateRuntimeSecrets,
    resolveSharedGatewaySessionGenerationForConfig: () => undefined,
    sharedGatewaySessionGenerationState: new SharedGatewaySessionGenerationState({
      current: undefined,
      required: null,
    }),
    clients: [],
    commitRuntimePolicy: vi.fn(),
    reconcileRuntimePolicy: vi.fn(),
  };
  const { onHotReload } = createManagedReloadSecretHandlers({
    params,
    prepareRuntimeCandidate: (config) => config,
    tryPrepareRuntimeSecrets: async (config) => ({
      snapshot: await prepare(config),
      expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
    }),
    applyHotReload: async (_plan, _config, publication) => {
      await beforePublication?.();
      let committed = false;
      try {
        await publication!.publish(
          async () => {
            await commit();
            committed = true;
          },
          () => committed,
        );
      } catch (error) {
        throw wrapPublicationError ? wrapPublicationError(error) : error;
      }
      return "applied";
    },
  });
  const ownership: GatewayConfigReloadTransactionOwnership = {
    isCurrent: () => true,
    checkpoint: async () => {},
    withRestartPreparation: async () => {
      throw new Error("Unexpected restart preparation in secret publication fixture");
    },
    markRuntimeCommitted: vi.fn(),
    commitRuntimeEnv: vi.fn(),
    publishRuntimeEnv: vi.fn(),
    rollbackRuntimeEnv: vi.fn(),
    reapplyRuntimeOverlays: (config) => config,
  };
  const plan = buildGatewayReloadPlan(diffConfigPaths(initial.source, next.source), {
    candidateConfig: next.config,
  });
  return {
    initial,
    next,
    ownership,
    run: () => onHotReload(plan, next.config, ownership, next.source),
  };
}

describe("managed reload authored source", () => {
  it.each(["same-source", "newer-write"] as const)(
    "rechecks config ownership after durable secrets publication preparation (%s)",
    async (observation) => {
      const initialConfig: OpenClawConfig = { gateway: { port: 18789 } };
      const config: OpenClawConfig = { gateway: { port: 18790 } };
      activateSecretsRuntimeSnapshot(await prepare(initialConfig));
      const prepared = await prepare(config);
      const revision = getActiveSecretsRuntimeSnapshotRevision();
      const snapshot = makeSnapshot({ config, hash: "candidate" });
      const published = vi.fn();
      const policies: Array<OpenClawConfig | null> = [];
      const activate = createRuntimeSecretsActivator({
        ...activatorOptions(),
        beforeSnapshotPublication: async (policy) => {
          policies.push(policy);
          if (policy !== prepared.config) {
            return;
          }
          if (observation === "newer-write") {
            harness.emitWrite({
              ...makeZeroDebounceHookWrite("successor"),
              snapshot: makeSnapshot({ config, hash: "successor" }),
              sourceConfig: config,
              runtimeConfig: config,
            });
          } else {
            harness.watcher.emit("change");
          }
        },
      });
      const runtime = { operationId: "secret-publication", generation: 2, pluginIds: ["notes"] };
      const harness = createReloaderHarness(async () => snapshot, {
        initialConfig: config,
        onHotReload: async (plan, nextConfig, ownership) => {
          const activated = await activate.activatePreparedSnapshotIfCurrent(
            prepared,
            revision,
            { reason: "reload", activate: true },
            published,
            ownership.isCurrent,
            ownership.checkpoint,
          );
          if (!activated) {
            throw new Error("Prepared secrets lost publication ownership");
          }
          ownership.markRuntimeCommitted(nextConfig, plan);
          return { status: "applied", runtime };
        },
      });
      await harness.reloader.ready;
      try {
        const operation = harness.reloader.applyPluginLifecycleChange({
          config,
          pluginIds: ["notes"],
          reason: "reload",
        });
        if (observation === "same-source") {
          await expect(operation).resolves.toBe(runtime);
          expect(published).toHaveBeenCalledOnce();
          expect(getActiveSecretsRuntimeSnapshotState()?.config).toEqual(prepared.config);
          expect(policies).toEqual([prepared.config]);
        } else {
          await expect(operation).rejects.toMatchObject({
            cause: expect.any(GatewayConfigReloadSupersededError),
          });
          expect(published).not.toHaveBeenCalled();
          expect(getActiveSecretsRuntimeSnapshotState()?.config).toEqual(initialConfig);
          expect(policies).toEqual([prepared.config, initialConfig]);
        }
      } finally {
        await harness.reloader.stop();
        clearSecretsRuntimeSnapshot();
      }
    },
  );

  it.each([false, true])(
    "commits the exact target before publication (hook fails: %s)",
    async (fails) => {
      const initial = await prepare({ gateway: { port: 18789 } });
      const candidate = await prepare({ gateway: { port: 18790 } });
      activateSecretsRuntimeSnapshot(initial);
      const failure = new Error("durable publication failed");
      const beforeSnapshotPublication = vi.fn(async (config: OpenClawConfig | null) => {
        expect(getActiveSecretsRuntimeSnapshotState()?.config).toEqual(initial.config);
        if (fails && config === candidate.config) {
          throw failure;
        }
      });
      const options = {
        ...activatorOptions(),
        activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshot,
        beforeSnapshotPublication,
      };
      const activate = createRuntimeSecretsActivator(options);
      const publication = activate.activatePreparedSnapshotIfCurrent(
        candidate,
        getActiveSecretsRuntimeSnapshotRevisionState(),
        { reason: "reload", activate: true },
      );
      if (fails) {
        await expect(publication).rejects.toBe(failure);
        expect(beforeSnapshotPublication.mock.calls.map(([config]) => config)).toEqual([
          candidate.config,
          initial.config,
        ]);
      } else {
        await expect(publication).resolves.toBe(candidate);
        expect(beforeSnapshotPublication).toHaveBeenCalledExactlyOnceWith(candidate.config);
      }
      expect(getActiveSecretsRuntimeSnapshotState()?.config).toEqual(
        fails ? initial.config : candidate.config,
      );
    },
  );

  it.each(["snapshot", "admission"] as const)(
    "reconciles the survivor when %s ownership changes during the durable hook",
    async (supersession) => {
      const initial = await prepare({ gateway: { port: 18789 } });
      const candidate = await prepare({ gateway: { port: 18790 } });
      const successor = await prepare({ gateway: { port: 18791 } });
      activateSecretsRuntimeSnapshot(initial);
      const entered = createDeferred();
      const release = createDeferred();
      const beforeSnapshotPublication = vi.fn(async (config: OpenClawConfig | null) => {
        if (config === candidate.config) {
          entered.resolve();
          await release.promise;
        }
      });
      const activator = createRuntimeSecretsActivator({
        ...activatorOptions(),
        activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshot,
        beforeSnapshotPublication,
      });
      let current = true;
      const published = vi.fn();
      const pending = activator.activatePreparedSnapshotIfCurrent(
        candidate,
        getActiveSecretsRuntimeSnapshotRevisionState(),
        { reason: "reload", activate: true },
        published,
        () => current,
      );
      await entered.promise;
      expect(getActiveSecretsRuntimeSnapshotState()?.config).toEqual(initial.config);
      if (supersession === "snapshot") {
        activateSecretsRuntimeSnapshot(successor);
      } else {
        current = false;
      }
      release.resolve();
      await expect(pending).resolves.toBeNull();
      expect(published).not.toHaveBeenCalled();
      const survivor = supersession === "snapshot" ? successor : initial;
      expect(beforeSnapshotPublication.mock.calls.map(([config]) => config)).toEqual([
        candidate.config,
        survivor.config,
      ]);
      expect(getActiveSecretsRuntimeSnapshotState()?.config).toEqual(survivor.config);
    },
  );

  it.each([false, true])(
    "reconciles a throwing publisher (snapshot replaced: %s)",
    async (replaced) => {
      const initial = await prepare({ gateway: { port: 18789 } });
      const candidate = await prepare({ gateway: { port: 18790 } });
      activateSecretsRuntimeSnapshot(initial);
      const beforeSnapshotPublication = vi.fn(async (_config: OpenClawConfig | null) => {});
      const failure = new Error("snapshot publication failed");
      const activator = createRuntimeSecretsActivator({
        ...activatorOptions(),
        beforeSnapshotPublication,
        activateRuntimeSecretsSnapshot: (snapshot) => {
          if (replaced) {
            activateSecretsRuntimeSnapshot(snapshot);
          }
          throw failure;
        },
      });
      await expect(
        activator.activatePreparedSnapshot(candidate, {
          reason: "reload",
          activate: true,
        }),
      ).rejects.toBe(failure);
      const survivor = replaced ? candidate : initial;
      expect(beforeSnapshotPublication.mock.calls.map(([config]) => config)).toEqual([
        candidate.config,
        survivor.config,
      ]);
      expect(getActiveSecretsRuntimeSnapshotState()?.config).toEqual(survivor.config);
    },
  );

  it.each([false, true])(
    "durably publishes the exact three-way rollback (inside callback: %s)",
    async (insideCallback) => {
      const initial = await prepare({ gateway: { port: 18789 } });
      const candidate = await prepare({ gateway: { port: 18790 } });
      const descendant = await prepare({ gateway: { port: 18790, bind: "lan" } });
      const merged = { gateway: { port: 18789, bind: "lan" } };
      activateSecretsRuntimeSnapshot(initial);
      const beforeSnapshotPublication = vi.fn(async (config: OpenClawConfig | null) => {
        expect(getActiveSecretsRuntimeSnapshotState()?.config).toEqual(
          config === candidate.config ? initial.config : descendant.config,
        );
      });
      const activator = createRuntimeSecretsActivator({
        ...activatorOptions(),
        activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshot,
        beforeSnapshotPublication,
      });
      let publishedRevision = 0;
      const restoreMerged = async (restore: typeof activator.restoreSnapshotIfCurrent) => {
        expect(
          activateSecretsRuntimeSnapshotStateIfCurrent({
            snapshot: descendant,
            expectedRevision: publishedRevision,
            preserveActivationLineage: true,
            refreshContext: null,
            refreshHandler: null,
          }),
        ).toBe(true);
        await expect(restore(initial, publishedRevision, candidate)).resolves.toBe(true);
      };
      await activator.activatePreparedSnapshotIfCurrent(
        candidate,
        getActiveSecretsRuntimeSnapshotRevisionState(),
        { reason: "reload", activate: true },
        async (restore) => {
          publishedRevision = getActiveSecretsRuntimeSnapshotRevisionState();
          if (insideCallback) {
            await restoreMerged(restore);
          }
        },
      );
      if (!insideCallback) {
        await restoreMerged(activator.restoreSnapshotIfCurrent);
      }
      expect(beforeSnapshotPublication.mock.calls.map(([config]) => config)).toEqual([
        candidate.config,
        merged,
      ]);
      expect(getActiveSecretsRuntimeSnapshotState()?.config).toEqual(merged);
    },
  );

  it("rejects a closed plugin invoker before activating its prepared secrets", async () => {
    const failure = new Error("plugin invoker closed");
    const commit = vi.fn(async () => {});
    let invokerOpen = true;
    const { initial, ownership, run } = await createReload(commit, async () => {
      invokerOpen = false;
    });
    const revision = getActiveSecretsRuntimeSnapshotRevision();
    ownership.assertInvokerOwned = () => {
      if (!invokerOpen) {
        throw failure;
      }
    };
    await expect(run()).rejects.toBe(failure);
    expect(commit).not.toHaveBeenCalled();
    expect(getActiveSecretsRuntimeSnapshotRevision()).toBe(revision);
    expectAuthoredSource(initial.source);
  });

  it.each(["direct", "plugin restored", "plugin committed", "plugin cleanup failed"] as const)(
    "retries stale secret publication only after safe recovery: %s",
    async (recovery) => {
      const refreshed = configPair("openclaw");
      refreshed.source.models.providers.openai.models[0]!.name = "Refreshed model";
      refreshed.config.models!.providers!.openai!.models[0]!.name = "Refreshed model";
      const snapshot = await prepare(refreshed.config);
      const commit = vi.fn(async () => {});
      let publicationAttempts = 0;
      const { next, run } = await createReload(
        commit,
        async () => {
          if (publicationAttempts++ === 0) {
            activateSecretsRuntimeSnapshotWithSource(snapshot, refreshed.source);
          }
        },
        recovery === "direct"
          ? undefined
          : (error) => {
              return new PluginRuntimeApplicationError(
                "Plugin activation failed",
                {
                  operationId: "secret-publication",
                  generation: 1,
                  pluginIds: ["fixture"],
                  phase: "activate",
                  committed: recovery === "plugin committed",
                },
                {
                  cause:
                    recovery === "plugin cleanup failed"
                      ? new AggregateError([error, new Error("Plugin cleanup failed")])
                      : error,
                },
              );
            },
      );
      if (recovery === "plugin cleanup failed" || recovery === "plugin committed") {
        await expect(run()).rejects.toBeInstanceOf(PluginRuntimeApplicationError);
        expect(commit).not.toHaveBeenCalled();
        expect(publicationAttempts).toBe(1);
        expectAuthoredSource(refreshed.source);
      } else {
        await expect(run()).resolves.toBe("applied");
        expect(commit).toHaveBeenCalledOnce();
        expect(publicationAttempts).toBe(2);
        expectAuthoredSource(next.source);
      }
    },
  );

  it("preserves generated model metadata across a successful hot reload", async () => {
    const { next, run } = await createReload(async () => {});
    await expect(run()).resolves.toBe("applied");
    expect(
      getRuntimeConfigSnapshot()?.agents?.defaults?.models?.["openai/gpt-5.6-luna"]?.agentRuntime
        ?.id,
    ).toBe("codex");
    expectAuthoredSource(next.source);
  });

  it("restores source and cold context limits before model replacement settles after commit failure", async () => {
    const initial = configPair("openclaw", 32_768);
    const next = configPair("codex", 65_536);
    const candidateOnlyModel = "rollback-candidate-only";
    for (const config of [next.source, next.config]) {
      const provider: ModelProviderConfig = config.models!.providers!.openai!;
      provider.models.push({
        ...provider.models[0]!,
        id: candidateOnlyModel,
        contextWindow: 16_384,
      });
    }
    resetContextWindowCacheForTest();
    const failure = new Error("commit failed");
    const { ownership, run } = await createReload(
      async () => {
        // The candidate is visible before commit; a cold synchronous reader can cache its limits.
        expect(lookupContextTokens("gpt-5.6-luna", { allowAsyncLoad: false })).toBe(65_536);
        expect(lookupContextTokens(candidateOnlyModel, { allowAsyncLoad: false })).toBe(16_384);
        throw failure;
      },
      undefined,
      undefined,
      { initial, next },
    );
    const { markPreparedModelRuntimeSnapshotsStale, rejectPendingPreparedModelRuntimeReplacement } =
      await import("../agents/prepared-model-runtime.js");
    const replacement = markPreparedModelRuntimeSnapshotsStale("plugin reload is preparing", {
      waitForReplacement: true,
    });
    // Independent teardown also releases the gate if the original self-wait times out the test.
    finishPendingModelReload = async () => {
      rejectPendingPreparedModelRuntimeReplacement(replacement, failure);
      await verification.catch(() => {});
      await closePreparedModelRuntimeSnapshots();
    };

    const verification = (async () => {
      await expect(run()).rejects.toBe(failure);
      expect(ownership.markRuntimeCommitted).not.toHaveBeenCalled();
      expectAuthoredSource(initial.source);
      expect(getActiveSecretsRuntimeSnapshotState()?.config).toEqual(initial.config);
      expect(lookupContextTokens("gpt-5.6-luna", { allowAsyncLoad: false })).toBe(32_768);
      expect(lookupContextTokens(candidateOnlyModel, { allowAsyncLoad: false })).toBeUndefined();
    })();
    await verification;
  });

  it("does not roll back a newer publication's authored source", async () => {
    const newer = configPair("codex");
    newer.source.models.providers.openai.models[0]!.name = "Newer model";
    newer.config.models!.providers!.openai!.models[0]!.name = "Newer model";
    const { run } = await createReload(async () => {
      activateSecretsRuntimeSnapshotWithSource(await prepare(newer.config), newer.source);
      throw new Error("superseded commit failed");
    });
    await expect(run()).rejects.toThrow("superseded commit failed");
    expectAuthoredSource(newer.source);
  });
});
