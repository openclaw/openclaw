import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveContextTokensForModel } from "../agents/context.js";
import { resetContextWindowCacheForTest } from "../agents/context.test-support.js";
import { closePreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.lifecycle.js";
import { createModelProviderRouteOverrideResolver } from "../config/model-provider-config.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
} from "../config/runtime-snapshot.js";
import { projectConfigOntoRuntimeSourceSnapshot } from "../config/runtime-source-projection.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
} from "../config/runtime-write-application.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
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
import * as skillsDiscovery from "../skills/runtime/refresh.js";
import { diffConfigPaths } from "./config-diff.js";
import { buildGatewayReloadPlan } from "./config-reload-plan.js";
import type { GatewayConfigReloadTransactionOwnership } from "./config-reload.js";
import {
  closeTestConfigReloaders,
  createReloaderHarness,
  createConfigReloadTestClock,
  makeWrite,
  makeSnapshot,
} from "./config-reload.test-support.js";
import { GatewayHotReloadStaleSecretsError } from "./server-reload-contracts.js";
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

function configPair(
  runtime: "openclaw" | "codex",
  contextWindow?: number,
  name = "Luna",
  extraModel?: { id: string; contextWindow: number },
) {
  const model: ModelDefinitionConfig = {
    id: "gpt-5.6-luna",
    name,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: 4096,
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };
  const source = {
    agents: { defaults: { models: { "openai/gpt-5.6-luna": { agentRuntime: { id: runtime } } } } },
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          models: [model, ...(extraModel ? [{ ...model, ...extraModel }] : [])],
        },
      },
    },
  } satisfies OpenClawConfig;
  const config: OpenClawConfig = structuredClone(source);
  // The loader may seed catalog compatibility; this is not authored request policy.
  for (const runtimeModel of config.models!.providers!.openai!.models) {
    runtimeModel.compat = { supportsStore: false };
  }
  return { source, config };
}

const prepare = (config: OpenClawConfig, env = {}) =>
  prepareSecretsRuntimeSnapshot({ config, includeAuthStoreRefs: false, env });
const reloadActivation = { reason: "reload", activate: true } as const;
type Activator = ReturnType<typeof createRuntimeSecretsActivator>;
type Snapshot = Awaited<ReturnType<typeof prepare>>;
type PublishArgs = Parameters<Activator["activatePreparedSnapshotIfCurrent"]>;

function publish(
  activator: Activator,
  candidate: Snapshot,
  ...callbacks: [PublishArgs[3]?, PublishArgs[4]?, PublishArgs[5]?]
) {
  return activator.activatePreparedSnapshotIfCurrent(
    candidate,
    getActiveSecretsRuntimeSnapshotRevisionState(),
    reloadActivation,
    ...callbacks,
  );
}

function createActivator(
  overrides: Partial<Parameters<typeof createRuntimeSecretsActivator>[0]> = {},
) {
  return createRuntimeSecretsActivator({
    logSecrets: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    emitStateEvent: vi.fn(),
    prepareRuntimeSecretsSnapshot: ({ config }: { config: OpenClawConfig }) => prepare(config),
    activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshot,
    ...overrides,
  });
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

function expectContextTokens(model: string, expected: number | undefined) {
  expect(resolveContextTokensForModel({ model, allowAsyncLoad: false })).toBe(expected);
}

type SecretHandlerOptions = Parameters<typeof createManagedReloadSecretHandlers>[0];

function createSecretHandlers(
  activateRuntimeSecrets: SecretHandlerOptions["params"]["activateRuntimeSecrets"],
  prepareSnapshot: typeof prepare,
  applyHotReload: SecretHandlerOptions["applyHotReload"] = async (_plan, _config, publication) => {
    let committed = false;
    await publication!.publish(
      async () => {
        committed = true;
      },
      () => committed,
    );
    return "applied";
  },
) {
  return createManagedReloadSecretHandlers({
    params: {
      activateRuntimeSecrets,
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      sharedGatewaySessionGenerationState: new SharedGatewaySessionGenerationState({
        current: undefined,
        required: null,
      }),
      clients: [],
      commitRuntimePolicy: vi.fn(),
      reconcileRuntimePolicy: vi.fn(),
    },
    prepareRuntimeCandidate: (config) => config,
    tryPrepareRuntimeSecrets: async (config) => ({
      snapshot: await prepareSnapshot(config),
      expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
    }),
    applyHotReload,
    hasPendingModelRuntimeReload: () => false,
  });
}

async function prepareCandidates() {
  const initial = await prepare({ gateway: { port: 18789 } });
  const candidate = await prepare({ gateway: { port: 18790 } });
  activateSecretsRuntimeSnapshot(initial);
  return [initial, candidate] as const;
}

function expectPublishedConfigs(
  publication: ReturnType<typeof vi.fn<(config: OpenClawConfig | null) => Promise<void>>>,
  ...configs: OpenClawConfig[]
) {
  expect(publication.mock.calls.map(([config]) => config)).toEqual(configs);
  expect(getActiveSecretsRuntimeSnapshotState()?.config).toEqual(configs.at(-1));
}

async function createReload(
  commit: () => Promise<void>,
  beforePublication?: () => Promise<void>,
  plugin?: { afterCommit?: () => void; cleanupFailure?: Error },
  { initial = configPair("openclaw"), next = configPair("codex") } = {},
) {
  activateSecretsRuntimeSnapshotWithSource(await prepare(initial.config), initial.source);
  expectAuthoredSource(initial.source);
  const activateRuntimeSecrets = createActivator();
  // Only secret publication is exercised here; the service tail is injected at its existing seam.
  const applyHotReload = vi.fn<SecretHandlerOptions["applyHotReload"]>(
    async (_plan, _config, publication) => {
      await beforePublication?.();
      let committed = false;
      try {
        await publication!.publish(
          async () => {
            await commit();
            committed = true;
            plugin?.afterCommit?.();
          },
          () => committed,
        );
      } catch (cause) {
        if (!plugin) {
          throw cause;
        }
        throw new PluginRuntimeApplicationError(
          "Plugin operation failed during activate",
          {
            operationId: "secrets-publication",
            generation: 1,
            pluginIds: ["fixture"],
            phase: "activate",
            committed,
          },
          {
            cause: plugin.cleanupFailure
              ? new AggregateError([cause, plugin.cleanupFailure], "Plugin rollback failed")
              : cause,
          },
        );
      }
      return "applied";
    },
  );
  const { onHotReload } = createSecretHandlers(activateRuntimeSecrets, prepare, applyHotReload);
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
    applyHotReload,
    run: () => onHotReload(plan, next.config, ownership, next.source),
  };
}

describe("managed reload authored source", () => {
  it("acknowledges a delayed managed write already applied by the watcher with resolved secrets", async () => {
    const initial: OpenClawConfig = { gateway: { reload: {} } };
    const source: OpenClawConfig = {
      ...initial,
      models: {
        providers: {
          fixture: {
            baseUrl: "https://fixture.example.invalid/v1",
            apiKey: { source: "env", provider: "default", id: "RELOAD_KEY" },
            models: [],
          },
        },
      },
    };
    const prepareSnapshot = (config: OpenClawConfig) =>
      prepare(config, { RELOAD_KEY: "resolved-fixture-key" });
    activateSecretsRuntimeSnapshotWithSource(await prepareSnapshot(initial), initial);
    const activateRuntimeSecrets = createActivator({
      prepareRuntimeSecretsSnapshot: ({ config }) => prepareSnapshot(config),
    });
    const handlers = createSecretHandlers(activateRuntimeSecrets, prepareSnapshot);
    const refresh = vi.spyOn(skillsDiscovery, "refreshSkillsDiscovery").mockResolvedValue();
    const { clock, scheduler } = createConfigReloadTestClock();
    const snapshot = makeSnapshot({ config: source, hash: "saved-secret-source" });
    const readSnapshot = vi.fn(async () => makeSnapshot({ config: initial, hash: "initial" }));
    const harness = createReloaderHarness(readSnapshot, {
      scheduler,
      initialConfig: initial,
      onHotReload: handlers.onHotReload,
      onNoopConfigCommit: handlers.onHotReload,
      onEffectiveConfigUnchanged: handlers.onEffectiveConfigUnchanged,
    });
    await harness.reloader.ready;
    readSnapshot.mockResolvedValue(snapshot);
    harness.watcher.emit("change");
    await clock.advanceBy(0);
    expect(getRuntimeConfigSnapshot()?.models?.providers?.fixture?.apiKey).toBe(
      "resolved-fixture-key",
    );
    expect(refresh).toHaveBeenCalledOnce();

    const application = createRuntimeConfigWriteApplication();
    const settled: string[] = [];
    void application.result.then((status) => settled.push(status));
    harness.emitWrite(
      attachRuntimeConfigWriteApplication(
        makeWrite(source, "saved-secret-source", { snapshot }),
        application,
      ),
    );
    await clock.advanceBy(0);

    expect(settled).toEqual(["applied"]);
    expect(getRuntimeConfigSnapshot()?.models?.providers?.fixture?.apiKey).toBe(
      "resolved-fixture-key",
    );
    expect(getRuntimeConfigSourceSnapshot()).toEqual(source);
    expect(harness.onHotReload).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    await harness.reloader.stop();
  });

  it("publishes prepared secrets through a same-source watcher echo", async () => {
    const initialConfig: OpenClawConfig = { gateway: { port: 18789 } };
    const config: OpenClawConfig = { gateway: { port: 18790 } };
    activateSecretsRuntimeSnapshot(await prepare(initialConfig));
    const prepared = await prepare(config);
    const revision = getActiveSecretsRuntimeSnapshotRevision();
    const snapshot = makeSnapshot({ config, hash: "candidate" });
    const published = vi.fn();
    const policies: Array<OpenClawConfig | null> = [];
    const activate = createActivator({
      beforeSnapshotPublication: async (policy) => {
        policies.push(policy);
        if (policy === prepared.config) {
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
          reloadActivation,
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
    await expect(
      harness.reloader.applyPluginLifecycleChange({
        config,
        pluginIds: ["notes"],
        reason: "reload",
      }),
    ).resolves.toBe(runtime);
    expect(published).toHaveBeenCalledOnce();
    expect(getActiveSecretsRuntimeSnapshotState()?.config).toEqual(prepared.config);
    expect(policies).toEqual([prepared.config]);
  });

  it.each(["hook fails", "publisher fails", "publisher replaces then fails"] as const)(
    "commits the exact target and reconciles publication outcome: %s",
    async (outcome) => {
      const [initial, candidate] = await prepareCandidates();
      const publisherFails = outcome.startsWith("publisher");
      const replaced = outcome === "publisher replaces then fails";
      const failure = new Error(
        publisherFails ? "snapshot publication failed" : "durable publication failed",
      );
      const beforeSnapshotPublication = vi.fn(async (config: OpenClawConfig | null) => {
        if (!publisherFails) {
          expect(getActiveSecretsRuntimeSnapshotState()?.config).toEqual(initial.config);
          if (config === candidate.config) {
            throw failure;
          }
        }
      });
      const activate = createActivator({
        beforeSnapshotPublication,
        activateRuntimeSecretsSnapshot: publisherFails
          ? (snapshot) => {
              if (replaced) {
                activateSecretsRuntimeSnapshot(snapshot);
              }
              throw failure;
            }
          : activateSecretsRuntimeSnapshot,
      });
      const publication = publisherFails
        ? activate.activatePreparedSnapshot(candidate, reloadActivation)
        : publish(activate, candidate);
      const survivor = replaced ? candidate : initial;
      await expect(publication).rejects.toBe(failure);
      expectPublishedConfigs(beforeSnapshotPublication, candidate.config, survivor.config);
      expect(getActiveSecretsRuntimeSnapshotState()?.config).toEqual(survivor.config);
    },
  );

  it.each(["snapshot", "admission"] as const)(
    "reconciles the survivor when %s ownership changes during the durable hook",
    async (supersession) => {
      const [initial, candidate] = await prepareCandidates();
      const successor = await prepare({ gateway: { port: 18791 } });
      const entered = createDeferred();
      const release = createDeferred();
      const beforeSnapshotPublication = vi.fn(async (config: OpenClawConfig | null) => {
        if (config === candidate.config) {
          entered.resolve();
          await release.promise;
        }
      });
      const activator = createActivator({ beforeSnapshotPublication });
      let current = true;
      const published = vi.fn();
      const pending = publish(activator, candidate, published, () => current);
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
      expectPublishedConfigs(beforeSnapshotPublication, candidate.config, survivor.config);
    },
  );

  it.each([false, true])(
    "durably publishes the exact three-way rollback (inside callback: %s)",
    async (insideCallback) => {
      const [initial, candidate] = await prepareCandidates();
      const descendant = await prepare({ gateway: { port: 18790, bind: "lan" } });
      const merged = { gateway: { port: 18789, bind: "lan" } } satisfies OpenClawConfig;
      const beforeSnapshotPublication = vi.fn(async (config: OpenClawConfig | null) => {
        expect(getActiveSecretsRuntimeSnapshotState()?.config).toEqual(
          config === candidate.config ? initial.config : descendant.config,
        );
      });
      const activator = createActivator({ beforeSnapshotPublication });
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
      await publish(activator, candidate, async (restore) => {
        publishedRevision = getActiveSecretsRuntimeSnapshotRevisionState();
        if (insideCallback) {
          await restoreMerged(restore);
        }
      });
      if (!insideCallback) {
        await restoreMerged(activator.restoreSnapshotIfCurrent);
      }
      expectPublishedConfigs(beforeSnapshotPublication, candidate.config, merged);
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
      const committed = recovery === "plugin committed";
      const cleanupFailed = recovery === "plugin cleanup failed";
      const refreshed = configPair("openclaw", undefined, "Refreshed model");
      const snapshot = await prepare(refreshed.config);
      const commit = vi.fn(async () => {});
      const cleanupFailure = new Error("candidate cleanup failed");
      const beforePublication = vi.fn(async () => {
        if (!committed && beforePublication.mock.calls.length === 1) {
          activateSecretsRuntimeSnapshotWithSource(snapshot, refreshed.source);
        }
      });
      const afterCommit = vi.fn(() => {
        if (committed && afterCommit.mock.calls.length === 1) {
          throw new GatewayHotReloadStaleSecretsError();
        }
      });
      const { next, ownership, applyHotReload, run } = await createReload(
        commit,
        beforePublication,
        recovery === "direct"
          ? undefined
          : { afterCommit, ...(cleanupFailed ? { cleanupFailure } : {}) },
      );
      const result = await run().catch((error: unknown) => error);
      if (cleanupFailed || committed) {
        assert(result instanceof PluginRuntimeApplicationError);
        expect(result.details.committed).toBe(committed);
        if (cleanupFailed) {
          assert(result.cause instanceof AggregateError);
          expect(result.cause.errors).toEqual([
            expect.any(GatewayHotReloadStaleSecretsError),
            cleanupFailure,
          ]);
          expect(getRuntimeConfigSnapshot()?.models?.providers?.openai?.models[0]?.name).toBe(
            "Refreshed model",
          );
        } else {
          expect(result.cause).toBeInstanceOf(GatewayHotReloadStaleSecretsError);
        }
      } else {
        expect(result).toBe("applied");
        expect(getRuntimeConfigSnapshot()).toMatchObject(next.source);
      }
      expect(applyHotReload).toHaveBeenCalledTimes(cleanupFailed || committed ? 1 : 2);
      expect(commit).toHaveBeenCalledTimes(cleanupFailed ? 0 : 1);
      expect(ownership.markRuntimeCommitted).toHaveBeenCalledTimes(cleanupFailed ? 0 : 1);
      expectAuthoredSource(cleanupFailed ? refreshed.source : next.source);
    },
  );

  it("restores source and cold context limits before model replacement settles after commit failure", async () => {
    const initial = configPair("openclaw", 32_768);
    const candidateOnlyModel = "rollback-candidate-only";
    const next = configPair("codex", 65_536, "Luna", {
      id: candidateOnlyModel,
      contextWindow: 16_384,
    });
    resetContextWindowCacheForTest();
    const failure = new Error("commit failed");
    const { ownership, run } = await createReload(
      async () => {
        // The candidate is visible before commit; a cold synchronous reader can cache its limits.
        expectContextTokens("gpt-5.6-luna", 65_536);
        expectContextTokens(candidateOnlyModel, 16_384);
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
      expectContextTokens("gpt-5.6-luna", 32_768);
      expectContextTokens(candidateOnlyModel, undefined);
    })();
    await verification;
  });

  it("does not roll back a newer publication's authored source", async () => {
    const newer = configPair("codex", undefined, "Newer model");
    const { run } = await createReload(async () => {
      activateSecretsRuntimeSnapshotWithSource(await prepare(newer.config), newer.source);
      throw new Error("superseded commit failed");
    });
    await expect(run()).rejects.toThrow("superseded commit failed");
    expectAuthoredSource(newer.source);
  });
});
