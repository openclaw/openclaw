import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-records.js";
import { writePersistedInstalledPluginIndexSync } from "./installed-plugin-index-store-write.js";
import {
  extractPluginInstallRecordsFromInstalledPluginIndex,
  loadInstalledPluginIndex,
} from "./installed-plugin-index.js";
import { loadOpenClawPlugins } from "./loader.js";
import { resetPluginLoaderTestStateForTest } from "./loader.test-fixtures.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import type { PluginRegistry } from "./registry-types.js";
import { disposePluginRegistryInstances } from "./runtime.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  cleanupTrackedTempDirs(tempDirs);
});

it.each(["global", "bundled", "bundled without package.json"] as const)(
  "retains a %s runtime across persisted and fresh metadata, but replaces it when its inputs change",
  async (kind) => {
    const origin = kind === "global" ? "global" : "bundled";
    const hasPackage = kind !== "bundled without package.json";
    const root = makeTrackedTempDir("openclaw-loader-metadata-retention", tempDirs);
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    const bundledDir = path.join(root, "bundled");
    const env = {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: origin === "global" ? "1" : undefined,
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
    };
    const packageDir =
      origin === "global"
        ? writeManagedNpmPlugin({
            stateDir,
            packageName: "metadata-sibling",
            pluginId: "metadata-sibling",
            version: "1.0.0",
          })
        : path.join(bundledDir, "metadata-sibling");
    const entryPath = hasPackage
      ? path.join(packageDir, "dist", "index.js")
      : path.join(packageDir, "index.js");
    fs.mkdirSync(path.dirname(entryPath), { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "metadata-sibling",
        configSchema: { type: "object" },
      }),
    );
    const writeDescription = (description: string) =>
      fs.writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({
          name: "metadata-sibling",
          version: "1.0.0",
          type: "commonjs",
          description,
          openclaw: { extensions: ["./dist/index.js"] },
        }),
      );
    if (hasPackage) {
      writeDescription("Original package description");
    }
    const registrationEvent = `metadata-sibling-registration:${root}`;
    const registered = vi.fn();
    process.on(registrationEvent, registered);
    fs.writeFileSync(
      entryPath,
      `module.exports = { id: 'metadata-sibling', register(api) {
      const instance = require('node:crypto').randomUUID();
      const lifetime = new AbortController();
      process.emit(${JSON.stringify(registrationEvent)}, instance);
      api.lifecycle.onDispose(() => lifetime.abort());
      api.registerGatewayMethod('metadata-sibling.probe', ({ respond }) => {
        lifetime.signal.throwIfAborted();
        respond(true, instance);
      });
    } };`,
    );
    const config: OpenClawConfig = {
      agents: { entries: { main: { workspace: workspaceDir } } },
      plugins: {
        allow: ["metadata-sibling"],
        entries: { "metadata-sibling": { enabled: true } },
        slots: { memory: "none" },
      },
    };
    const registries: PluginRegistry[] = [];
    const caches: ReturnType<typeof createPluginCache>[] = [];
    try {
      await withEnvAsync(env, async () => {
        writePersistedInstalledPluginIndexSync(
          loadInstalledPluginIndex({
            config,
            env,
            workspaceDir,
            installRecords:
              origin === "global"
                ? {
                    "metadata-sibling": {
                      source: "npm",
                      spec: "metadata-sibling@1.0.0",
                      version: "1.0.0",
                      installPath: packageDir,
                    },
                  }
                : {},
          }),
          { env },
        );
        const installRecords = loadInstalledPluginIndexInstallRecordsSync({ env });
        const load = (preferPersisted: boolean, nextWorkspace = workspaceDir) => {
          const cache = createPluginCache();
          caches.push(cache);
          const nextConfig: OpenClawConfig = {
            ...config,
            agents: { entries: { main: { workspace: nextWorkspace } } },
          };
          return withPluginCache(cache, () => {
            // Read the same committed installation facts through both real metadata producers.
            const snapshot = loadPluginMetadataSnapshot({
              config: nextConfig,
              env,
              workspaceDir: nextWorkspace,
              allowCurrent: false,
              preferPersisted,
              ...(!preferPersisted ? { installRecords } : {}),
            });
            expect(snapshot.registrySource).toBe(preferPersisted ? "persisted" : "derived");
            const snapshotInstallRecords = extractPluginInstallRecordsFromInstalledPluginIndex(
              snapshot.index,
            );
            expect(snapshotInstallRecords).toEqual(installRecords);
            const registry = loadOpenClawPlugins({
              config: nextConfig,
              env,
              workspaceDir: nextWorkspace,
              installRecords: snapshotInstallRecords,
              manifestRegistry: snapshot.manifestRegistry,
              discovery: snapshot.discovery,
              previousRegistry: registries.at(-1),
              activate: false,
              cache: false,
              runtimeSideEffects: true,
              throwOnLoadError: true,
            });
            registries.push(registry);
            const record = registry.plugins.find((entry) => entry.id === "metadata-sibling");
            const manifest = snapshot.manifestRegistry.plugins.find(
              (entry) => entry.id === "metadata-sibling",
            );
            const handler = registry.gatewayHandlers["metadata-sibling.probe"];
            assert.ok(record && manifest && handler);
            expect(record.origin).toBe(origin);
            expect.soft(manifest.packageDependencies).toEqual({});
            expect.soft(manifest.packageOptionalDependencies).toEqual({});
            return { record, manifest, handler };
          });
        };
        const initial = load(true);
        expect
          .soft(initial.manifest.packageDescription)
          .toBe(hasPackage ? "Original package description" : undefined);
        const call = async (handler: typeof initial.handler) => {
          const respond = vi.fn();
          await handler({
            req: { type: "req", id: "metadata-retention", method: "metadata-sibling.probe" },
            params: {},
            client: null,
            isWebchatConnect: () => false,
            respond,
            context: {} as GatewayRequestHandlerOptions["context"],
          });
          expect(respond).toHaveBeenCalledExactlyOnceWith(
            true,
            expect.any(String),
            undefined,
            undefined,
          );
          return respond.mock.calls[0]?.[1];
        };
        const initialResponse = await call(initial.handler);
        // First installation can derive metadata; the following settings reload hydrates it.
        for (const preferPersisted of [false, true]) {
          const current = load(preferPersisted);
          expect
            .soft(current.manifest.packageDescription)
            .toBe(hasPackage ? "Original package description" : undefined);
          expect.soft(current.manifest).toEqual(initial.manifest);
          expect.soft(current.record).toBe(initial.record);
          expect.soft(current.handler).toBe(initial.handler);
          expect.soft(await call(current.handler)).toBe(initialResponse);
          expect.soft(registered).toHaveBeenCalledTimes(1);
        }
        if (!hasPackage) {
          return;
        }
        let previous = initial;
        let nextWorkspace = workspaceDir;
        let expectedRegistrations = 1;
        if (origin === "global") {
          nextWorkspace = path.join(root, "other-workspace");
          const changed = load(false, nextWorkspace);
          expect(changed.manifest.workspaceDir).toBe(nextWorkspace);
          expect(changed.record).not.toBe(initial.record);
          expect(changed.handler).not.toBe(initial.handler);
          expect(await call(changed.handler)).not.toBe(initialResponse);
          expect.soft(registered).toHaveBeenCalledTimes(++expectedRegistrations);
          previous = changed;
        }
        // A real package metadata edit must still replace the runtime; cache-path
        // equivalence must not remove description from the loader's full comparison.
        writeDescription("Updated package description");
        const changedDescription = load(false, nextWorkspace);
        expect(changedDescription.manifest.packageDescription).toBe("Updated package description");
        expect(changedDescription.record).not.toBe(previous.record);
        expect(changedDescription.handler).not.toBe(previous.handler);
        expect(await call(changedDescription.handler)).not.toBe(await call(previous.handler));
        expect.soft(registered).toHaveBeenCalledTimes(expectedRegistrations + 1);
      });
    } finally {
      for (const registry of registries.toReversed()) {
        await disposePluginRegistryInstances(registry);
      }
      for (const cache of caches.toReversed()) {
        await cache[Symbol.asyncDispose]();
      }
      process.off(registrationEvent, registered);
    }
  },
);
