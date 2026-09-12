import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import { acquireReadOnlyPreparedModelRuntime } from "../agents/prepared-model-runtime.js";
import type {
  PreparedModelRuntimeInput,
  PreparedModelRuntimeLease,
} from "../agents/prepared-model-runtime.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getCurrentPluginMetadataSnapshot,
  withPluginMetadataSnapshotScope,
} from "../plugins/current-plugin-metadata-snapshot.js";
import {
  getPluginCache,
  getPluginMetadataSnapshotCache,
  type PluginCache,
} from "../plugins/plugin-cache.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { resolveEffectiveThinkingProfile } from "../plugins/provider-thinking.js";
import { setActivePluginRegistry, waitForPluginRegistryRetirement } from "../plugins/runtime.js";
import { getGatewayContextLifetime } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getFreePort } from "../test-utils/ports.js";
import { createGatewayMemoryCloseRegistryFactory } from "./server-close.memory.test-support.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";

type BuildObservation = {
  previous: Promise<void> | undefined;
  completion: Promise<void>;
  metadata: PluginMetadataSnapshot | undefined;
  cache: PluginCache;
};

function modelConfig(base: OpenClawConfig, provider: string): OpenClawConfig {
  return {
    ...base,
    models: {
      providers: {
        [provider]: {
          api: "openai-completions",
          baseUrl: "https://model-cache.invalid/v1",
          models: [
            {
              id: "selected",
              name: "Synthetic policy model",
              reasoning: true,
              input: ["text"],
              contextWindow: 4096,
              maxTokens: 512,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
    agents: {
      ...base.agents,
      defaults: { ...base.agents?.defaults, model: `${provider}/selected` },
    },
  };
}

it.each(["active", "closing-memory"] as const)(
  "retires captured model work and cold policy when another Gateway is %s",
  { timeout: 120_000 },
  async (siblingState) => {
    const fixture = await createGatewayMetadataCloseFixture(`queued-model-${siblingState}`);
    const warmId = "warm-model-policy",
      coldId = "cold-model-policy";
    const policyRoots = new Map<string, string>();
    const markers = new Map<string, string>();
    const lazyMarker = fixture.state.path("model-policy-lazy-evaluated");
    const runtimeMarker = fixture.state.path("model-policy-runtime-evaluated");
    for (const id of [warmId, coldId]) {
      const root = fixture.state.path(id);
      fs.mkdirSync(root);
      policyRoots.set(id, fs.realpathSync(root));
      const marker = fixture.state.path(`${id}-evaluated`);
      markers.set(id, marker);
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({
          name: id,
          version: "1.0.0",
          type: "commonjs",
          openclaw: { extensions: ["./index.cjs"] },
        }),
      );
      fs.writeFileSync(
        path.join(root, "openclaw.plugin.json"),
        JSON.stringify({
          id,
          providers: [id],
          configSchema: { type: "object", properties: {} },
        }),
      );
      fs.writeFileSync(
        path.join(root, "index.cjs"),
        `require('node:fs').writeFileSync(${JSON.stringify(runtimeMarker)}, 'unexpected'); throw Error('policy runtime must stay cold');`,
      );
      fs.writeFileSync(
        path.join(root, "lazy.cjs"),
        `require('node:fs').appendFileSync(${JSON.stringify(lazyMarker)}, 'evaluated\\n'); exports.profile = { levels: [{id:'off'}], defaultLevel:'off' };`,
      );
      fs.writeFileSync(
        path.join(root, "provider-policy-api.js"),
        `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'evaluated\\n');
         exports.resolveThinkingProfile = ({modelId}) => modelId === 'lazy'
           ? require('./lazy.cjs').profile
           : { levels: [{id:'off'},{id:'high'}], defaultLevel:'high' };`,
      );
    }
    assert(fixture.config.plugins?.load?.paths && fixture.config.plugins.entries);
    fixture.config.plugins.load.paths.push(...policyRoots.values());
    for (const id of policyRoots.keys()) {
      fixture.config.plugins.entries[id] = { enabled: false };
    }

    const manifests = await import("../plugins/manifest-registry-installed.js");
    const readManifests = manifests.loadPluginManifestRegistryForInstalledIndex;
    // Host trust is explicit fixture input. Paths/origin and subsequent immutable
    // metadata production, artifact loading and policy invocation remain real.
    const trust = vi
      .spyOn(manifests, "loadPluginManifestRegistryForInstalledIndex")
      .mockImplementation((params) => {
        const registry = readManifests(params);
        return {
          ...registry,
          plugins: registry.plugins.map((record) =>
            policyRoots.has(record.id) &&
            policyRoots.get(record.id) === fs.realpathSync(record.rootDir)
              ? Object.assign({}, record, { trustedOfficialInstall: true })
              : record,
          ),
        };
      });
    const gateEntered = createDeferredCore(),
      releaseBuild = createDeferredCore();
    const memoryEntered = createDeferredCore(),
      releaseMemory = createDeferredCore();
    const leases: PreparedModelRuntimeLease[] = [];
    const builds: BuildObservation[] = [];
    const jobs: Promise<PreparedModelRuntimeLease>[] = [];
    const closing: Promise<void>[] = [];
    const restorers: Array<() => void> = [];
    let refuseMemory = true;
    let completedMemoryCloses = 0;
    try {
      const aPort = await getFreePort(),
        bPort = await getFreePort();
      const aServer = await fixture.start(aPort),
        bServer = await fixture.start(bPort);
      const a = fixture.kernels.get(aPort),
        b = fixture.kernels.get(bPort);
      assert(a && b);
      const registryClose = vi.spyOn(b.pluginRuntime, "close");
      restorers.push(() => registryClose.mockRestore());
      // Two starts may share one cache. A real B publication gives each kernel
      // a distinct inventory before A acquires the callbacks being retired.
      await b.kernel.reloadPlugins({
        nextConfig: b.cfgAtStart,
        sourceConfig: b.cfgAtStart,
        changedPaths: [],
        prepareConfigEffects: () => {},
        pluginLifecycle: {
          reason: "reload",
          operationId: "queued-model-b",
          pluginIds: [fixture.pluginId],
        },
        commitRuntime: async (publication) => {
          publication?.publish();
          publication?.afterCommit?.();
        },
        env: fixture.state.env,
      });
      const aMetadata = a.getPluginMetadataSnapshot(),
        bMetadata = b.getPluginMetadataSnapshot();
      assert(aMetadata && bMetadata);
      const aCache = getPluginMetadataSnapshotCache(aMetadata),
        bCache = getPluginMetadataSnapshotCache(bMetadata);
      expect(aCache).not.toBe(bCache);
      for (const id of policyRoots.keys()) {
        expect(aMetadata.byPluginId.get(id)?.trustedOfficialInstall).toBe(true);
        expect(aMetadata.byPluginId.get(id)?.origin).not.toBe("bundled");
      }
      const agentDir = fixture.state.agentDir("model-cache");
      const input = (provider: string, workspace: string): PreparedModelRuntimeInput => {
        const workspaceDir = fixture.state.path(workspace);
        fs.mkdirSync(workspaceDir, { recursive: true });
        return {
          config: modelConfig(fixture.config, provider),
          agentId: "main",
          agentDir,
          inheritedAuthDir: agentDir,
          workspaceDir,
          env: fixture.state.env,
          skipCredentials: true,
        };
      };
      const acquire = (metadata: PluginMetadataSnapshot, selected: PreparedModelRuntimeInput) =>
        withPluginMetadataSnapshotScope(
          metadata,
          () => acquireReadOnlyPreparedModelRuntime(selected, { catalogMode: "static" }),
          { config: selected.config, env: fixture.state.env, trustConfigIdentity: true },
        );
      const warmA = await acquire(aMetadata, input(warmId, "warm-a"));
      leases.push(warmA);
      expect(warmA.snapshot.metadataSnapshot).toBe(aMetadata);
      const warmEntry = warmA.snapshot.modelCatalog.entries.find(
        (entry) => entry.provider === warmId,
      );
      assert(warmEntry, "Real model publication must produce the policy-owned catalog row");
      const readPolicy = (entry: ModelCatalogEntry, modelId = "selected") =>
        resolveEffectiveThinkingProfile({
          provider: warmId,
          context: { provider: warmId, modelId },
          catalogEntry: entry,
        });
      expect(readPolicy(warmEntry)?.defaultLevel).toBe("high");
      expect(fs.existsSync(markers.get(warmId)!)).toBe(true);
      expect(fs.existsSync(markers.get(coldId)!)).toBe(false);
      expect(fs.existsSync(lazyMarker)).toBe(false);
      const warmOwner = [...aCache.setupModules.values()].find(
        (instance) => instance.pluginId === warmId,
      );
      assert(warmOwner, "Cold positive control must acquire A's real setup owner");
      const warmB = await acquire(bMetadata, input(warmId, "warm-b"));
      leases.push(warmB);
      const bEntry = warmB.snapshot.modelCatalog.entries.find((entry) => entry.provider === warmId);
      assert(bEntry);
      expect(warmB.snapshot.isCurrent()).toBe(true);
      expect(readPolicy(bEntry)?.defaultLevel).toBe("high");
      expect(
        [...bCache.setupModules.values()].find((instance) => instance.pluginId === warmId),
      ).not.toBe(warmOwner);

      const memoryConfig: OpenClawConfig = {
        ...fixture.config,
        plugins: { enabled: true },
        memory: {
          search: {
            provider: "fixture-embedding",
            model: "synthetic-embedding",
            fallback: "none",
            store: { vector: { enabled: false } },
          },
        },
      };
      const createMemory = await createGatewayMemoryCloseRegistryFactory(memoryConfig);
      const memoryFailure = new Error("queued-model memory close refused");
      const memoryClose = vi.fn(async () => {
        memoryEntered.resolve();
        await releaseMemory.promise;
        if (refuseMemory) {
          throw memoryFailure;
        }
        completedMemoryCloses += 1;
      });
      const memory = createMemory(memoryClose);
      const previousB = b.pluginRuntime.registry;
      setActivePluginRegistry(memory.registry);
      b.pluginRuntime.publish(memory.registry);
      await waitForPluginRegistryRetirement(previousB);
      const managed = await memory.runtime.getMemorySearchManager({
        cfg: memoryConfig,
        agentId: "main",
      });
      assert(managed.manager, managed.error ?? "Sibling memory manager unavailable");
      await managed.manager.probeEmbeddingAvailability();

      const staticCatalog = await import("../agents/models-config.providers.implicit.js");
      const prepareStatic = staticCatalog.prepareImplicitProviderStaticCatalog;
      let holdNext = true;
      const held = vi
        .spyOn(staticCatalog, "prepareImplicitProviderStaticCatalog")
        .mockImplementation(async (params) => {
          if (holdNext) {
            holdNext = false;
            expect(params.pluginMetadataSnapshot).toBe(aMetadata);
            expect(getPluginCache()).toBe(aCache);
            gateEntered.resolve();
            await releaseBuild.promise;
          }
          return prepareStatic(params);
        });
      restorers.push(() => held.mockRestore());
      const runtimeBuild = await import("../agents/prepared-model-runtime.build.js");
      const startBuild = runtimeBuild.startSerializedSnapshotBuildBatch;
      const observed = vi
        .spyOn(runtimeBuild, "startSerializedSnapshotBuildBatch")
        .mockImplementation((candidates, completions, ...rest) => {
          const previous = completions.get(agentDir);
          const cache = getPluginCache();
          const metadata = getCurrentPluginMetadataSnapshot({
            allowScopedSnapshot: true,
            allowWorkspaceScopedSnapshot: true,
          });
          const build = startBuild(candidates, completions, ...rest);
          builds.push({ previous, completion: build.completion, cache, metadata });
          return build;
        });
      restorers.push(() => observed.mockRestore());
      const caches = await import("../plugins/plugin-cache.js");
      const retireCache = caches.retirePluginCache;
      let retirementRequested = false;
      const retirementObserver = vi
        .spyOn(caches, "retirePluginCache")
        .mockImplementation((cache, ...rest) => {
          const retirement = retireCache(cache, ...rest);
          if (cache === aCache) {
            retirementRequested = true;
          }
          return retirement;
        });
      restorers.push(() => retirementObserver.mockRestore());
      const first = acquire(aMetadata, input(warmId, "blocked-a"));
      jobs.push(first);
      void first.catch(() => {});
      await Promise.race([
        gateEntered.promise,
        first.then(() => {
          throw new Error("Model build bypassed the real static catalog gate");
        }),
      ]);
      const queued = acquire(aMetadata, input(coldId, "queued-a"));
      jobs.push(queued);
      void queued.catch(() => {});
      expect(builds).toHaveLength(2);
      expect(builds[1]!.previous).toBe(builds[0]!.completion);
      for (const build of builds) {
        expect(build.cache).toBe(aCache);
        expect(build.metadata).toBe(aMetadata);
      }
      expect(fs.existsSync(markers.get(coldId)!)).toBe(false);

      if (siblingState === "closing-memory") {
        const bClose = bServer.close({ reason: "hold real sibling memory cleanup" });
        closing.push(bClose);
        void bClose.catch(() => {});
        await Promise.race([
          memoryEntered.promise,
          bClose.then(() => {
            throw new Error("Sibling closed without entering memory cleanup");
          }),
        ]);
        expect(getGatewayContextLifetime(b.resolvePluginGatewayContext).signal.aborted).toBe(false);
      }
      const aClose = aServer.close({ reason: "retire captured queued model metadata" });
      closing.push(aClose);
      void aClose.catch(() => {});
      await expect.poll(() => retirementRequested, { timeout: 10_000 }).toBe(true);
      expect(getPluginMetadataSnapshotCache(aMetadata)).toBe(aCache);
      expect(aCache.retirement).toBeUndefined();
      expect(warmOwner.lifecycle.signal.aborted).toBe(false);
      expect(readPolicy(warmEntry)?.defaultLevel).toBe("high");
      // The admitted lease and raw build retain their captured inventory until they finish.
      await warmA[Symbol.asyncDispose]();
      expect(aCache.retirement).toBeUndefined();
      expect(warmOwner.lifecycle.signal.aborted).toBe(false);
      releaseBuild.resolve();
      await Promise.all(builds.map(({ completion }) => completion));
      for (const job of [first, queued]) {
        await expect(job).rejects.toEqual(
          new Error("Plugin inventory has retired; begin a new plugin operation."),
        );
      }
      await aClose;
      const retiredWarmMessage = `Plugin ${warmId} was reloaded or disabled; use its current tools.`;
      expect(() => readPolicy(warmEntry, "lazy")).toThrow(retiredWarmMessage);
      expect(fs.existsSync(lazyMarker)).toBe(false);
      expect(warmOwner.lifecycle.signal.aborted).toBe(true);
      expect(aCache.setupModules.size).toBe(0);
      expect(fs.existsSync(markers.get(coldId)!)).toBe(false);
      expect(fs.existsSync(runtimeMarker)).toBe(false);
      expect(getPluginMetadataSnapshotCache(bMetadata)).toBe(bCache);
      expect(bCache.retirement).toBeUndefined();
      expect(warmB.snapshot.isCurrent()).toBe(true);
      let failedMemoryAttempts = 0;
      if (siblingState === "active") {
        expect(readPolicy(bEntry)?.defaultLevel).toBe("high");
        const freshB = await acquire(bMetadata, input(warmId, "fresh-b"));
        leases.push(freshB);
        expect(freshB.snapshot).not.toBe(warmB.snapshot);
        expect(freshB.snapshot.metadataSnapshot).toBe(bMetadata);
        expect(freshB.snapshot.isCurrent()).toBe(true);
        const freshEntry = freshB.snapshot.modelCatalog.entries.find(
          (entry) => entry.provider === warmId,
        );
        assert(freshEntry);
        expect(readPolicy(freshEntry)?.defaultLevel).toBe("high");
        expect(memoryClose).not.toHaveBeenCalled();
      } else {
        expect(memoryClose).toHaveBeenCalledOnce();
        await warmB[Symbol.asyncDispose]();
        releaseMemory.resolve();
        await closing[0];
        const registryResult = await registryClose.mock.results[0]?.value;
        expect(registryResult?.memoryErrors).toContain(memoryFailure);
        failedMemoryAttempts = memoryClose.mock.calls.length;
        expect(completedMemoryCloses).toBe(0);
        expect(getGatewayContextLifetime(b.resolvePluginGatewayContext).signal.aborted).toBe(true);
      }
      refuseMemory = false;
      releaseMemory.resolve();
      // These fixture-owned admissions must end before final Gateway close can join them.
      for (const lease of leases) {
        await lease[Symbol.asyncDispose]();
      }
      await bServer.close({ reason: "join sibling memory cleanup" });
      expect(registryClose).toHaveBeenCalledOnce();
      expect(memoryClose).toHaveBeenCalledTimes(
        siblingState === "active" ? 1 : failedMemoryAttempts,
      );
      expect(completedMemoryCloses).toBe(siblingState === "active" ? 1 : 0);
      expect(bCache.retirement).toBeDefined();
      expect(warmB.snapshot.isCurrent()).toBe(false);
    } finally {
      refuseMemory = false;
      releaseBuild.resolve();
      releaseMemory.resolve();
      const settledJobs = await Promise.allSettled(jobs);
      for (const job of settledJobs) {
        if (job.status === "fulfilled") {
          await job.value[Symbol.asyncDispose]();
        }
      }
      for (const lease of leases) {
        await lease[Symbol.asyncDispose]();
      }
      await Promise.allSettled([...builds.map(({ completion }) => completion), ...closing]);
      for (const restore of restorers.toReversed()) {
        restore();
      }
      trust.mockRestore();
      await fixture.cleanup();
    }
  },
);
