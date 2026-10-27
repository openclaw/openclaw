import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { modelDefinition, providerConfig } from "../agents/model-auth.fixtures.test-support.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import { acquireReadOnlyPreparedModelRuntime } from "../agents/prepared-model-runtime.js";
import { registerPreparedModelRuntimeClose } from "../agents/prepared-model-runtime.lifecycle.js";
import type {
  PreparedModelRuntimeInput,
  PreparedModelRuntimeLease,
} from "../agents/prepared-model-runtime.types.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { getPluginMetadataSnapshotCache } from "../plugins/plugin-cache.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { resolveEffectiveThinkingProfile } from "../plugins/provider-thinking.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";

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
      const write = (name: string, value: string) => fs.writeFileSync(path.join(root, name), value);
      const writeJson = (name: string, value: unknown) => write(name, JSON.stringify(value));
      writeJson("package.json", {
        name: id,
        version: "1.0.0",
        type: "commonjs",
        openclaw: { extensions: ["./index.cjs"] },
      });
      writeJson("openclaw.plugin.json", {
        id,
        providers: [id],
        configSchema: { type: "object", properties: {} },
      });
      write(
        "index.cjs",
        `require('node:fs').writeFileSync(${JSON.stringify(runtimeMarker)}, 'unexpected'); throw Error('policy runtime must stay cold');`,
      );
      write(
        "lazy.cjs",
        `require('node:fs').appendFileSync(${JSON.stringify(lazyMarker)}, 'evaluated\\n'); exports.profile = { levels: [{id:'off'}], defaultLevel:'off' };`,
      );
      write(
        "provider-policy-api.js",
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
    let warmA: PreparedModelRuntimeLease | undefined;
    const jobs: Promise<PreparedModelRuntimeLease>[] = [];
    let closing: Promise<void> | undefined;
    const restorers: Array<() => void> = [];
    try {
      const { server: aServer, kernel: a } = await fixture.startServer();
      const aMetadata = a.getPluginMetadataSnapshot();
      assert(aMetadata);
      const aCache = getPluginMetadataSnapshotCache(aMetadata);
      const agentDir = fixture.state.agentDir("model-cache");
      const input = (provider: string, workspace: string): PreparedModelRuntimeInput => {
        const workspaceDir = fixture.state.path(workspace);
        fs.mkdirSync(workspaceDir, { recursive: true });
        return {
          config: {
            ...fixture.config,
            ...providerConfig(provider, {
              api: "openai-completions",
              baseUrl: "https://model-cache.invalid/v1",
              models: [modelDefinition("selected")],
            }),
            agents: {
              defaults: { ...fixture.config.agents?.defaults, model: `${provider}/selected` },
            },
          },
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
      warmA = await acquire(aMetadata, input(warmId, "warm-a"));
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
      const expectMarkers = (warm: boolean) =>
        expect(
          [markers.get(warmId)!, markers.get(coldId)!, lazyMarker, runtimeMarker].map(
            fs.existsSync,
          ),
        ).toEqual([warm, false, false, false]);
      expectMarkers(true);
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
            gateEntered.resolve();
            await releaseBuild.promise;
          }
          return prepareStatic(params);
        });
      restorers.push(() => held.mockRestore());
      const modelCloseEntered = createDeferredCore<Error>();
      restorers.push(
        registerPreparedModelRuntimeClose(async (error) => {
          modelCloseEntered.resolve(error);
        }),
      );
      const first = acquire(aMetadata, input(warmId, "blocked-a"));
      jobs.push(first);
      void first.catch(() => {});
      await awaitGateBeforeSettlement(
        gateEntered.promise,
        first,
        "Model build bypassed the real static catalog gate",
      );
      const queued = acquire(aMetadata, input(coldId, "queued-a"));
      jobs.push(queued);
      void queued.catch(() => {});
      expectMarkers(true);

      const aClose = aServer.close({ reason: "retire captured queued model metadata" });
      closing = aClose;
      void aClose.catch(() => {});
      const shutdownError = await awaitGateBeforeSettlement(
        modelCloseEntered.promise,
        aClose,
        "Gateway closed without joining model acquisition",
      );
      expect(shutdownError.message).toBe("prepared model runtime process lifetime closed");
      expect(warmOwner.lifecycle.signal.aborted).toBe(false);
      expect(readPolicy(warmEntry)?.defaultLevel).toBe("high");
      // The admitted lease and raw build retain their captured inventory until they finish.
      await warmA[Symbol.asyncDispose]();
      expect(warmOwner.lifecycle.signal.aborted).toBe(false);
      releaseBuild.resolve();
      await expect(first).rejects.toBe(shutdownError);
      await expect(queued).rejects.toMatchObject({
        message: `prepared model runtime publication was superseded for ${agentDir}`,
        admissionBlocked: false,
      });
      await aClose;
      const retiredWarmMessage = `Plugin ${warmId} was reloaded or disabled; use its current tools.`;
      expect(() => readPolicy(warmEntry, "lazy")).toThrow(retiredWarmMessage);
      expect(warmOwner.lifecycle.signal.aborted).toBe(true);
      expect(aCache.setupModules.size).toBe(0);
      expectMarkers(true);
    } finally {
      releaseBuild.resolve();
      const settledJobs = await Promise.allSettled(jobs);
      for (const job of settledJobs) {
        if (job.status === "fulfilled") {
          await job.value[Symbol.asyncDispose]();
        }
      }
      await warmA?.[Symbol.asyncDispose]();
      await Promise.allSettled([closing]);
      for (const restore of restorers.toReversed()) {
        restore();
      }
      trust.mockRestore();
      await fixture.cleanup();
    }
  },
);
