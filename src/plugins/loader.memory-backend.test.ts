/** Verifies opted-in non-owner memory plugins load only as passive backends for the slot owner. */
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  cleanupPluginLoaderFixturesForTest,
  loadOpenClawPlugins,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { getActiveMemoryProviderCore } from "./memory-runtime.js";
import { resetStandaloneMemoryRegistrySlot } from "./memory-runtime.test-support.js";

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

const modesKey = "__memoryBackendFixtureModes";
type FixtureGlobal = typeof globalThis & {
  [modesKey]?: Record<string, string[]> & {
    listed?: string[];
    backendHits?: string[];
    closed?: string[];
  };
};

function writeMemoryPlugin(id: string, dir: string, manifestExtra: Record<string, unknown> = {}) {
  const plugin = writePlugin({
    id,
    dir,
    filename: `${id}.cjs`,
    body: `module.exports = {
      id: ${JSON.stringify(id)},
      kind: "memory",
      register(api) {
        const modes = (globalThis[${JSON.stringify(modesKey)}] ??= {});
        (modes[${JSON.stringify(id)}] ??= []).push(api.registrationMode);
        const seen = globalThis[${JSON.stringify(modesKey)}];
        const reference = { providerId: ${JSON.stringify(id)}, id: "1" };
        const handle = {
          capabilities: { sources: ["memory"], pagination: false, candidates: [], projectFilter: false },
          search: async () => ({ hits: [{ reference, excerpt: ${JSON.stringify(`${id} hit`)} }] }),
          get: async () => ({ status: "not_found" }),
          health: async () => ({ status: "ready" }),
          close: async () => { (seen.closed ??= []).push(${JSON.stringify(id)}); },
        };
        api.registerMemoryCapability({
          providerRuntime: {
            async open(params) {
              if (params.backends) {
                seen.listed = params.backends.list().map((backend) => backend.id);
                const opened = await params.backends.open("memory-store");
                const page = await opened.provider.search({ query: "q" });
                seen.backendHits = page.hits.map((hit) => hit.excerpt);
              }
              return { provider: handle };
            },
          },
        });
        api.registerTool({ name: ${JSON.stringify(`${id}_tool`)}, description: "fixture",
          parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) });
        api.on("agent_end", () => {});
        api.registerService({ id: ${JSON.stringify(`${id}-worker`)}, start() {} });
      },
    };`,
  });
  const manifestPath = path.join(dir, "openclaw.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ ...manifest, kind: "memory", ...manifestExtra }),
    "utf-8",
  );
  return plugin;
}

function loadMemoryPlugins(params: {
  memoryBackend?: boolean;
  slot?: string;
  activate: boolean;
  /** Owner manifest declares `memoryBackends: true`. */
  ownerRequestsBackends?: boolean;
}) {
  useNoBundledPlugins();
  const root = makePluginLoaderTempDir();
  const owner = writeMemoryPlugin(
    "memory-fusion",
    path.join(root, "owner"),
    params.ownerRequestsBackends ? { memoryBackends: true } : {},
  );
  const store = writeMemoryPlugin("memory-store", path.join(root, "store"));
  delete (globalThis as FixtureGlobal)[modesKey];
  const config: OpenClawConfig = {
    plugins: {
      load: { paths: [owner.file, store.file] },
      allow: [owner.id, store.id],
      slots: { memory: params.slot ?? owner.id },
      entries: {
        [store.id]: {
          enabled: true,
          ...(params.memoryBackend === undefined ? {} : { memoryBackend: params.memoryBackend }),
        },
      },
    },
  };
  const registry = loadOpenClawPlugins({
    cache: false,
    activate: params.activate,
    workspaceDir: root,
    config,
    onlyPluginIds: [owner.id, store.id],
  });
  const ownedBy = (pluginId: string) => ({
    tools: registry.tools.filter((entry) => entry.pluginId === pluginId).length,
    typedHooks: registry.typedHooks.filter((entry) => entry.pluginId === pluginId).length,
    services: registry.services.filter((entry) => entry.pluginId === pluginId).length,
  });
  return {
    config,
    registry,
    store: registry.plugins.find((entry) => entry.id === store.id),
    modes: (globalThis as FixtureGlobal)[modesKey] ?? {},
    ownedBy,
  };
}

it.each([true, false])(
  "loads an opted-in memory plugin as a passive backend (activate: %s)",
  (activate) => {
    const { registry, store, modes, ownedBy } = loadMemoryPlugins({
      memoryBackend: true,
      activate,
    });
    expect(store).toMatchObject({ status: "loaded", enabled: true, memoryBackend: true });
    expect(modes["memory-store"]).toEqual(["memory-backend"]);
    expect(registry.memoryBackends.map(({ pluginId }) => pluginId)).toEqual(["memory-store"]);
    expect(registry.memoryCapabilities.map(({ pluginId }) => pluginId)).toEqual(["memory-fusion"]);
    expect(ownedBy("memory-store")).toEqual({ tools: 0, typedHooks: 0, services: 0 });
    expect(ownedBy("memory-fusion").services).toBe(1);
  },
);

it.each([
  { label: "without the opt-in", memoryBackend: undefined, slot: undefined },
  { label: 'while the memory slot is "none"', memoryBackend: true, slot: "none" },
])("keeps a non-owner memory plugin disabled $label", ({ memoryBackend, slot }) => {
  const { registry, store, modes } = loadMemoryPlugins({ memoryBackend, slot, activate: false });
  expect(store).toMatchObject({ enabled: false });
  expect(store?.memoryBackend).toBeUndefined();
  expect(modes["memory-store"]).toBeUndefined();
  expect(registry.memoryBackends).toEqual([]);
});

it("opens backends through a standalone slot owner lookup", async () => {
  const { config } = loadMemoryPlugins({ memoryBackend: true, activate: false });
  // The standalone path loads its own scoped registry: the slot owner plus opted-in backends.
  resetStandaloneMemoryRegistrySlot();
  const acquired = await getActiveMemoryProviderCore({
    cfg: config,
    agentId: "main",
    context: { authority: { kind: "host", operation: "backend-test" }, assertCurrent() {} },
  });
  const seen = (globalThis as FixtureGlobal)[modesKey]!;
  expect(acquired.providerId).toBe("memory-fusion");
  expect(seen.listed).toEqual(["memory-store"]);
  expect(seen.backendHits).toEqual(["memory-store hit"]);
  await acquired.provider!.close();
  expect(seen.closed).toEqual(["memory-fusion", "memory-store"]);
});

it.each([true, false])(
  "loads every enabled memory plugin as a backend when the owner manifest asks (activate: %s)",
  (activate) => {
    const { registry, store, modes, ownedBy } = loadMemoryPlugins({
      ownerRequestsBackends: true,
      activate,
    });
    expect(store).toMatchObject({ status: "loaded", enabled: true, memoryBackend: true });
    expect(modes["memory-store"]).toEqual(["memory-backend"]);
    expect(registry.memoryBackends.map(({ pluginId }) => pluginId)).toEqual(["memory-store"]);
    expect(registry.memoryCapabilities.map(({ pluginId }) => pluginId)).toEqual(["memory-fusion"]);
    expect(ownedBy("memory-store")).toEqual({ tools: 0, typedHooks: 0, services: 0 });
  },
);

it("keeps a plugin out of an owner-requested fusion with memoryBackend: false", () => {
  const { registry, store, modes } = loadMemoryPlugins({
    ownerRequestsBackends: true,
    memoryBackend: false,
    activate: false,
  });
  expect(store).toMatchObject({ enabled: false });
  expect(store?.memoryBackend).toBeUndefined();
  expect(modes["memory-store"]).toBeUndefined();
  expect(registry.memoryBackends).toEqual([]);
});

it("opens owner-requested backends through a standalone slot owner lookup", async () => {
  const { config } = loadMemoryPlugins({ ownerRequestsBackends: true, activate: false });
  resetStandaloneMemoryRegistrySlot();
  const acquired = await getActiveMemoryProviderCore({
    cfg: config,
    agentId: "main",
    context: { authority: { kind: "host", operation: "backend-test" }, assertCurrent() {} },
  });
  const seen = (globalThis as FixtureGlobal)[modesKey]!;
  expect(acquired.providerId).toBe("memory-fusion");
  expect(seen.listed).toEqual(["memory-store"]);
  expect(seen.backendHits).toEqual(["memory-store hit"]);
  await acquired.provider!.close();
});
