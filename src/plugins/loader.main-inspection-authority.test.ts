import fs from "node:fs";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { afterAll, afterEach, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { setGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { selectCurrentPluginMetadataCache } from "./current-plugin-metadata-state.js";
import { refreshPersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import type { PluginLoadOptions } from "./loader-types.js";
import { acquirePluginRegistryForInspection } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePluginMetadata,
} from "./loader.test-fixtures.js";
import {
  createPluginCache,
  getProcessPluginCache,
  retirePluginCache,
  withPluginCache,
} from "./plugin-cache.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";
import type { PluginRegistry } from "./registry-types.js";

const PLUGIN_ID = "main-inspection-authority";
const authority = Symbol.for("openclaw.test.mainInspectionAuthority");

type AuthoritySlot = {
  evaluations: number;
  registrations: number;
  effects: number;
  gate: PromiseWithResolvers<void>;
  stale?: Promise<void>;
  neighborError?: string;
  sources: string[];
};

afterEach(async () => {
  Reflect.deleteProperty(globalThis, authority);
  try {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    resetPluginLoaderTestStateForTest();
  } finally {
    clearRuntimeConfigSnapshot();
  }
});
afterAll(cleanupPluginLoaderFixturesForTest);

const providers = (registry: PluginRegistry) =>
  registry.providers.map(({ provider }) => `${provider.id}:${provider.label}`).toSorted();

/** Writes a global native ESM plugin and runs cold main-thread inspections against it. */
async function withInstalledEsmPlugin(
  files: Record<string, string>,
  run: (fixture: {
    pluginDir: string;
    stateDir: string;
    install: (record: Omit<PluginInstallRecord, "installPath">) => Promise<void>;
    inspect: (
      workspace: string,
      pluginSdkResolution?: PluginLoadOptions["pluginSdkResolution"],
    ) => ReturnType<typeof acquirePluginRegistryForInspection>;
    publish: () => ReturnType<typeof createPluginCache>;
  }) => Promise<void>,
) {
  expect(isMainThread).toBe(true);
  useNoBundledPlugins();
  const stateDir = fs.realpathSync(makePluginLoaderTempDir());
  const pluginDir = path.join(stateDir, "extensions", PLUGIN_ID);
  fs.mkdirSync(pluginDir, { recursive: true });
  writePluginMetadata({
    dir: pluginDir,
    id: PLUGIN_ID,
    packageJson: {
      name: `@vendor/${PLUGIN_ID}`,
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.mjs"] },
    },
  });
  const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      id: PLUGIN_ID,
      configSchema: { type: "object", additionalProperties: false, properties: {} },
      providers: ["fixture-provider"],
    }),
  );
  for (const [name, source] of Object.entries(files)) {
    fs.writeFileSync(path.join(pluginDir, name), source);
  }
  const config: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "main" } },
      entries: Object.fromEntries(
        ["main", "research", "concurrent"].map((id) => [
          id,
          { workspace: path.join(stateDir, "workspace", id) },
        ]),
      ),
    },
    plugins: {
      allow: [PLUGIN_ID],
      entries: { [PLUGIN_ID]: { enabled: true } },
      slots: { memory: "none" },
    },
  };
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    setRuntimeConfigSnapshot(config);
    const previous = getProcessPluginCache();
    const inventories: ReturnType<typeof createPluginCache>[] = [];
    const inspections: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>>[] = [];
    try {
      await withPluginSourceCaptureStorage({ stateDir, placement: "state" }, () =>
        run({
          pluginDir,
          stateDir,
          install: (record) =>
            refreshPersistedInstalledPluginIndex({
              reason: "source-changed",
              installRecords: { [PLUGIN_ID]: { ...record, installPath: pluginDir } },
            }).then(() => undefined),
          inspect: async (workspace, pluginSdkResolution) => {
            const inspection = await acquirePluginRegistryForInspection({
              config,
              workspaceDir: path.join(stateDir, "workspace", workspace),
              pluginSdkResolution,
              throwOnLoadError: true,
            });
            inspections.push(inspection);
            return inspection;
          },
          publish: () => {
            const inventory = createPluginCache();
            inventories.push(inventory);
            const options = { config, workspaceDir: path.join(stateDir, "gateway") };
            const snapshot = withPluginCache(inventory, () =>
              loadPluginMetadataSnapshot({ ...options, allowCurrent: false }),
            );
            setGatewayPluginMetadataSnapshot(snapshot, options);
            return inventory;
          },
        }),
      );
    } finally {
      selectCurrentPluginMetadataCache(previous);
      for (const inspection of inspections.toReversed()) {
        await inspection.release();
      }
      for (const inventory of inventories.toReversed()) {
        await retirePluginCache(inventory);
      }
    }
  });
}

const npmInstall = (integrity: string, installedAt: string) =>
  ({
    source: "npm",
    spec: `@vendor/${PLUGIN_ID}@1.0.0`,
    resolvedSpec: `@vendor/${PLUGIN_ID}@1.0.0`,
    integrity,
    installedAt,
  }) as const;

it("bounds cold inspection code by workspace and SDK while retaining only live authority", async () => {
  const slot: AuthoritySlot = {
    evaluations: 0,
    registrations: 0,
    effects: 0,
    gate: Promise.withResolvers<void>(),
    sources: [],
  };
  Object.defineProperty(globalThis, authority, { value: slot, configurable: true });
  await withInstalledEsmPlugin(
    {
      "index.mjs": `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const slot = globalThis[Symbol.for("openclaw.test.mainInspectionAuthority")];
slot.evaluations++;
slot.sources.push(import.meta.url);
let latestApi;
const call = () => {
  latestApi.registerProvider({ id: "foreign-provider", label: "Foreign", auth: [] });
  slot.effects++;
};
slot.call ??= call;
export function register(api) {
  latestApi = api;
  slot.registrations++;
  api.registerProvider({
    id: "fixture-provider", label: "Fixture", auth: [],
    normalizeModelId() { return require("./lazy.cjs").value; },
  });
  if (slot.registrations === 1) {
    slot.stale = slot.gate.promise.then(call);
    slot.stale.catch(() => {});
  } else if (slot.registrations === 4) {
    try { slot.call(); } catch (error) { slot.neighborError = error.message; }
  }
}
`,
      "lazy.cjs": 'exports.value = "lazy";',
    },
    async ({ install, inspect, publish }) => {
      await install(npmInstall("sha512-authority", "2026-10-20T00:00:00.000Z"));
      const inventory = publish();
      const readLazy = (inspection: Awaited<ReturnType<typeof inspect>>) => {
        const provider = inspection.registry.providers.find(
          ({ provider: candidate }) => candidate.id === "fixture-provider",
        )?.provider;
        expect(
          provider?.normalizeModelId?.({ provider: "fixture-provider", modelId: "probe" }),
        ).toBe("lazy");
      };
      const retired = await inspect("main");
      const retiredRead = retired.registry.providers[0]!.provider.normalizeModelId!;
      await retired.release();
      const replacement = await inspect("main");
      expect(replacement.registry.plugins[0]).toMatchObject({ origin: "global", status: "loaded" });
      expect(slot).toMatchObject({ evaluations: 1, registrations: 2 });
      expect(() => retiredRead({ provider: "fixture-provider", modelId: "probe" })).toThrow();
      readLazy(replacement);
      const overlapping = await inspect("main");
      const neighbor = await inspect("research");
      expect(slot).toMatchObject({ evaluations: 2, registrations: 4 });
      expect(slot.neighborError).toContain("calling workspace generation");
      slot.gate.resolve();
      await expect(slot.stale).rejects.toThrow("calling workspace generation");
      expect(slot.effects).toBe(0);
      expect(providers(replacement.registry)).toEqual(["fixture-provider:Fixture"]);
      expect(providers(neighbor.registry)).toEqual(["fixture-provider:Fixture"]);

      // Registrations remain private, but repeating a cold inventory must not evaluate
      // another native graph for any configured workspace.
      for (let pass = 0; pass < 8; pass++) {
        for (const workspace of ["main", "research", "concurrent"]) {
          const current = await inspect(workspace);
          readLazy(current);
          await current.release();
        }
      }
      expect(slot.evaluations).toBe(3);
      expect(slot.registrations).toBe(28);
      for (const expected of [4, 5]) {
        const unknown = await inspect("unconfigured");
        expect(slot.evaluations).toBe(expected);
        await unknown.release();
      }
      for (let pass = 0; pass < 2; pass++) {
        const sourceSdk = await inspect("main", "src");
        expect(slot.evaluations).toBe(6);
        readLazy(sourceSdk);
        await sourceSdk.release();
      }
      const source = new URL(slot.sources[0]!);
      expect(fs.existsSync(source)).toBe(true);
      await retirePluginCache(inventory);
      expect(fs.existsSync(source)).toBe(true);
      readLazy(replacement);
      await Promise.all([replacement.release(), overlapping.release(), neighbor.release()]);
      expect(fs.existsSync(source)).toBe(false);
    },
  );
});

// Editable global installs (local or archive sources) and reinstalled npm packages must
// expose edited sources, including imported helpers, to the next cold inspection.
it.each([
  {
    name: "an editable archive install",
    before: { source: "archive" } as const,
    after: { source: "archive" } as const,
  },
  {
    name: "a reinstalled npm package",
    before: npmInstall("sha512-before", "2026-10-20T00:00:00.000Z"),
    after: npmInstall("sha512-after", "2026-10-20T01:00:00.000Z"),
  },
])("loads edited sources for the next inspection of $name", async ({ before, after }) => {
  await withInstalledEsmPlugin(
    {
      "index.mjs": `import { label } from "./label.mjs";
export function register(api) {
  api.registerProvider({ id: "fixture-provider", label, auth: [] });
}
`,
      "label.mjs": 'export const label = "before";',
    },
    async ({ pluginDir, install, inspect, publish }) => {
      await install(before);
      publish();
      const first = await inspect("main");
      expect(providers(first.registry)).toEqual(["fixture-provider:before"]);
      fs.writeFileSync(path.join(pluginDir, "label.mjs"), 'export const label = "after";');
      await install(after);
      publish();
      const second = await inspect("main");
      expect(providers(second.registry)).toEqual(["fixture-provider:after"]);
    },
  );
});
