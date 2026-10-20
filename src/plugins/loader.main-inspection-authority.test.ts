import fs from "node:fs";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { afterAll, afterEach, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { refreshPersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { acquirePluginRegistryForInspection } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePluginMetadata,
} from "./loader.test-fixtures.js";
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

const providerIds = (registry: PluginRegistry) =>
  registry.providers.map(({ provider }) => provider.id).toSorted();

// Shared main-thread code must keep registration authority generation-owned: a retired
// inspection's deferred call and a neighboring workspace's call through a retained
// replacement API are both rejected before any registry effect.
it("rejects neighboring and retired inspection generations using a retained replacement API", async () => {
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
  fs.writeFileSync(
    path.join(pluginDir, "index.mjs"),
    `const slot = (globalThis[Symbol.for("openclaw.test.mainInspectionAuthority")] ??= {
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
  if (slot.registrations === 1) {
    slot.stale = slot.gate.promise.then(call);
    slot.stale.catch(() => {});
  } else if (slot.registrations === 3) {
    try { slot.call(); } catch (error) { slot.neighborError = error.message; }
  }
}
`,
  );
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    await refreshPersistedInstalledPluginIndex({
      reason: "source-changed",
      installRecords: {
        [PLUGIN_ID]: { source: "npm", spec: `@vendor/${PLUGIN_ID}@1.0.0`, installPath: pluginDir },
      },
    });
    const config = {
      plugins: {
        allow: [PLUGIN_ID],
        entries: { [PLUGIN_ID]: { enabled: true } },
        slots: { memory: "none" },
      },
    };
    setRuntimeConfigSnapshot(config);
    const inspect = (workspaceDir: string) =>
      acquirePluginRegistryForInspection({ config, workspaceDir });
    await withPluginSourceCaptureStorage({ stateDir, placement: "state" }, async () => {
      const retired = await inspect(path.join(stateDir, "workspace", "main"));
      const replacement = await inspect(path.join(stateDir, "workspace", "main"));
      let neighbor: Awaited<ReturnType<typeof inspect>> | undefined;
      try {
        // SAFETY: The fixture module initializes this slot during its first evaluation.
        const slot = (globalThis as Record<symbol, AuthoritySlot>)[authority]!;
        expect(retired.registry.plugins[0]).toMatchObject({ origin: "global", status: "loaded" });
        expect(slot).toMatchObject({ evaluations: 1, registrations: 2 });
        await retired.release();

        neighbor = await inspect(path.join(stateDir, "workspace", "research"));
        expect(slot).toMatchObject({ evaluations: 2, registrations: 3 });
        expect(slot.neighborError).toContain("calling workspace generation");

        slot.gate.resolve();
        await expect(slot.stale).rejects.toThrow("calling workspace generation");
        expect(slot.effects).toBe(0);
        expect(providerIds(replacement.registry)).toEqual(["fixture-provider"]);
        expect(providerIds(neighbor.registry)).toEqual(["fixture-provider"]);
      } finally {
        await neighbor?.release();
        await replacement.release();
        await retired.release();
      }
    });
  });
}, 120_000);
