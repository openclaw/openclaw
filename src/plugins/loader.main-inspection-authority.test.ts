import fs from "node:fs";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
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

async function callFixtureGatewayMethod(handler: GatewayRequestHandler, method: string) {
  const respond = vi.fn();
  await handler({
    req: { type: "req", id: "fixture", method },
    params: {},
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: {} as Parameters<GatewayRequestHandler>[0]["context"],
  });
  return respond;
}
const authority = Symbol.for("openclaw.test.mainInspectionAuthority");

type AuthoritySlot = {
  evaluations: number;
  registrations: number;
  effects: number;
  gate: PromiseWithResolvers<void>;
  stale?: Promise<void>;
  neighborError?: string;
};

afterEach(async () => {
  vi.restoreAllMocks();
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
      ...JSON.parse(fs.readFileSync(manifestPath, "utf8")),
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

it("reuses only published workspace code while preserving inspection authority and capture lifetime", async () => {
  await withInstalledEsmPlugin(
    {
      "index.mjs": `const slot = (globalThis[Symbol.for("openclaw.test.mainInspectionAuthority")] ??= {
  evaluations: 0, registrations: 0, effects: 0, gate: Promise.withResolvers(),
});
slot.evaluations++;
let latestApi;
const call = () => {
  latestApi.registerProvider({ id: "foreign-provider", label: "Foreign", auth: [] });
  slot.effects++;
};
slot.call ??= call;
export function register(api) {
  latestApi = api;
  slot.registrations++;
  api.registerProvider({ id: "fixture-provider", label: "Fixture", auth: [] });
  api.registerGatewayMethod("fixture.read", async ({ respond }) => {
    const { value } = await import("./lazy.mjs");
    respond(true, value);
  });
  if (slot.registrations === 1) {
    slot.stale = slot.gate.promise.then(call);
    slot.stale.catch(() => {});
  } else if (slot.registrations === 4) {
    try { slot.call(); } catch (error) { slot.neighborError = error.message; }
  }
}
`,
      "lazy.mjs": 'export const value = "lazy";',
    },
    async ({ install, inspect, publish }) => {
      await install(npmInstall("sha512-authority", "2026-10-20T00:00:00.000Z"));
      const inventory = publish();
      const retired = await inspect("main");
      await retired.release();
      const replacement = await inspect("main");
      // SAFETY: The fixture module initializes this slot during its first evaluation.
      const slot = (globalThis as Record<symbol, AuthoritySlot>)[authority]!;
      expect(replacement.registry.plugins[0]).toMatchObject({ origin: "global", status: "loaded" });
      expect(slot).toMatchObject({ evaluations: 1, registrations: 2 });
      const readLazy = async (inspection: typeof replacement) => {
        const respond = await callFixtureGatewayMethod(
          inspection.registry.gatewayHandlers["fixture.read"]!,
          "fixture.read",
        );
        expect(respond).toHaveBeenCalledExactlyOnceWith(true, "lazy", undefined, undefined);
      };
      await readLazy(replacement);
      const overlapping = await inspect("main");

      const neighbor = await inspect("research");
      expect(slot).toMatchObject({ evaluations: 2, registrations: 4 });
      expect(slot.neighborError).toContain("calling workspace generation");

      slot.gate.resolve();
      await expect(slot.stale).rejects.toThrow("calling workspace generation");
      expect(slot.effects).toBe(0);
      expect(providers(replacement.registry)).toEqual(["fixture-provider:Fixture"]);
      expect(providers(neighbor.registry)).toEqual(["fixture-provider:Fixture"]);

      const [left, right] = await Promise.all([inspect("concurrent"), inspect("concurrent")]);
      expect(slot.evaluations).toBe(3);
      await left.release();
      await readLazy(right);
      for (const expected of [4, 5]) {
        const unknown = await inspect("unconfigured");
        expect(slot.evaluations).toBe(expected);
        await unknown.release();
      }
      for (let pass = 0; pass < 2; pass++) {
        const sourceSdk = await inspect("main", "src");
        expect(slot.evaluations).toBe(6);
        await sourceSdk.release();
      }

      await retirePluginCache(inventory);
      await readLazy(replacement);
      await Promise.all([
        replacement.release(),
        overlapping.release(),
        neighbor.release(),
        right.release(),
      ]);
    },
  );
}, 120_000);

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
])(
  "loads edited sources for the next inspection of $name",
  async ({ before, after }) => {
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
  },
  120_000,
);
