import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withEnvAsync } from "../test-utils/env.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-records.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import {
  extractPluginInstallRecordsFromInstalledPluginIndex,
  loadInstalledPluginIndex,
} from "./installed-plugin-index.js";
import {
  callFixtureGatewayMethod,
  disposeLoaderFixtures,
  writeFixtureJson,
} from "./loader-fixture-builders.test-support.js";
import { loadOpenClawPlugins } from "./loader.js";
import { resetPluginLoaderTestStateForTest } from "./loader.test-fixtures.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import type { PluginRegistry } from "./registry-types.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

const tempDirs: string[] = [];

afterEach(async () => {
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  await closeStateDatabaseForTest();
  cleanupTrackedTempDirs(tempDirs);
});

it.each(["global", "bundled", "bundled without package.json"] as const)(
  "retains a %s runtime across persisted and fresh metadata, but replaces it when its inputs change",
  async (kind) => {
    const id = "metadata-sibling";
    const method = `${id}.probe`;
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
        ? writeManagedNpmPlugin({ stateDir, packageName: id, pluginId: id, version: "1.0.0" })
        : path.join(bundledDir, id);
    const entryPath = hasPackage
      ? path.join(packageDir, "dist", "index.js")
      : path.join(packageDir, "index.js");
    fs.mkdirSync(path.dirname(entryPath), { recursive: true });
    writeFixtureJson(packageDir, "openclaw.plugin.json", { id, configSchema: { type: "object" } });
    const writeDescription = (description: string) =>
      writeFixtureJson(packageDir, "package.json", {
        name: id,
        version: "1.0.0",
        type: "commonjs",
        description,
        openclaw: { extensions: ["./dist/index.js"] },
      });
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
    const configFor = (workspace: string): OpenClawConfig => ({
      agents: { entries: { main: { workspace } } },
      plugins: {
        allow: [id],
        entries: { [id]: { enabled: true } },
        slots: { memory: "none" },
      },
    });
    const config = configFor(workspaceDir);
    const registries: PluginRegistry[] = [];
    const caches: ReturnType<typeof createPluginCache>[] = [];
    try {
      await withEnvAsync(env, async () => {
        await writePersistedInstalledPluginIndex(
          loadInstalledPluginIndex({
            config,
            env,
            workspaceDir,
            installRecords:
              origin === "global"
                ? {
                    [id]: {
                      source: "npm",
                      spec: `${id}@1.0.0`,
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
          const context = { config: configFor(nextWorkspace), env, workspaceDir: nextWorkspace };
          return withPluginCache(cache, () => {
            // Read the same committed installation facts through both real metadata producers.
            const snapshot = loadPluginMetadataSnapshot({
              ...context,
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
              ...context,
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
            const record = registry.plugins.find((entry) => entry.id === id);
            const manifest = snapshot.manifestRegistry.plugins.find((entry) => entry.id === id);
            const handler = registry.gatewayHandlers[method];
            assert.ok(record && manifest && handler);
            expect(record.origin).toBe(origin);
            expect
              .soft([manifest.packageDependencies, manifest.packageOptionalDependencies])
              .toEqual([{}, {}]);
            return { record, manifest, handler };
          });
        };
        const initial = load(true);
        expect
          .soft(initial.manifest.packageDescription)
          .toBe(hasPackage ? "Original package description" : undefined);
        const call = async (handler: typeof initial.handler) => {
          const respond = await callFixtureGatewayMethod(handler, method);
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
      await disposeLoaderFixtures(registries, caches);
      process.off(registrationEvent, registered);
    }
  },
);
