import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import { PreparedModelRuntimePublicationSupersededError } from "../agents/prepared-model-runtime.errors.js";
import { acquireReadOnlyPreparedModelRuntime } from "../agents/prepared-model-runtime.js";
import { registerPreparedModelRuntimeClose } from "../agents/prepared-model-runtime.lifecycle.js";
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
import { createDeferredCore } from "../shared/deferred.js";
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

it(
  "retires captured model work and cold policy during Gateway close",
  { timeout: 120_000 },
  async () => {
    const fixture = await createGatewayMetadataCloseFixture("queued-model-close");
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
    const leases: PreparedModelRuntimeLease[] = [];
    const builds: BuildObservation[] = [];
    const jobs: Promise<PreparedModelRuntimeLease>[] = [];
    const closing: Promise<void>[] = [];
    const restorers: Array<() => void> = [];
    try {
      const aPort = await fixture.reservePort();
      const aServer = await fixture.start(aPort);
      const a = fixture.kernels.get(aPort);
      assert(a);
      const aMetadata = a.getPluginMetadataSnapshot();
      assert(aMetadata);
      const aCache = getPluginMetadataSnapshotCache(aMetadata);
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
      const modelCloseEntered = createDeferredCore<Error>();
      restorers.push(
        registerPreparedModelRuntimeClose(async (error) => {
          modelCloseEntered.resolve(error);
        }),
      );
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

      const aClose = aServer.close({ reason: "retire captured queued model metadata" });
      closing.push(aClose);
      void aClose.catch(() => {});
      const shutdownError = await Promise.race([
        modelCloseEntered.promise,
        aClose.then(() => {
          throw new Error("Gateway closed without joining model acquisition");
        }),
      ]);
      expect(shutdownError.message).toBe("prepared model runtime process lifetime closed");
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
      await expect(first).rejects.toBe(shutdownError);
      await expect(queued).rejects.toThrow(PreparedModelRuntimePublicationSupersededError);
      await expect(queued).rejects.toThrow(
        `prepared model runtime publication was superseded for ${agentDir}`,
      );
      await aClose;
      const retiredWarmMessage = `Plugin ${warmId} was reloaded or disabled; use its current tools.`;
      expect(() => readPolicy(warmEntry, "lazy")).toThrow(retiredWarmMessage);
      expect(fs.existsSync(lazyMarker)).toBe(false);
      expect(warmOwner.lifecycle.signal.aborted).toBe(true);
      expect(aCache.setupModules.size).toBe(0);
      expect(fs.existsSync(markers.get(coldId)!)).toBe(false);
      expect(fs.existsSync(runtimeMarker)).toBe(false);
    } finally {
      releaseBuild.resolve();
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
