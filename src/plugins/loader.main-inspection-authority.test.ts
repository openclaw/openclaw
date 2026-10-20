import fs from "node:fs";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { afterAll, afterEach, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
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

const providers = (registry: PluginRegistry) =>
  registry.providers.map(({ provider }) => `${provider.id}:${provider.label}`).toSorted();

/** Writes a global native ESM plugin and runs cold main-thread inspections against it. */
async function withInstalledEsmPlugin(
  files: Record<string, string>,
  run: (fixture: {
    pluginDir: string;
    stateDir: string;
    install: (record: Omit<PluginInstallRecord, "installPath">) => Promise<void>;
    inspect: (workspace: string) => ReturnType<typeof acquirePluginRegistryForInspection>;
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
  const config = {
    plugins: {
      allow: [PLUGIN_ID],
      entries: { [PLUGIN_ID]: { enabled: true } },
      slots: { memory: "none" },
    },
  };
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    setRuntimeConfigSnapshot(config);
    await withPluginSourceCaptureStorage({ stateDir, placement: "state" }, () =>
      run({
        pluginDir,
        stateDir,
        install: (record) =>
          refreshPersistedInstalledPluginIndex({
            reason: "source-changed",
            installRecords: { [PLUGIN_ID]: { ...record, installPath: pluginDir } },
          }).then(() => undefined),
        inspect: (workspace) =>
          acquirePluginRegistryForInspection({
            config,
            workspaceDir: path.join(stateDir, "workspace", workspace),
          }),
      }),
    );
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

// Shared main-thread code must keep registration authority generation-owned: a retired
// inspection's deferred call and a neighboring workspace's call through a retained
// replacement API are both rejected before any registry effect.
it("rejects neighboring and retired inspection generations using a retained replacement API", async () => {
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
  if (slot.registrations === 1) {
    slot.stale = slot.gate.promise.then(call);
    slot.stale.catch(() => {});
  } else if (slot.registrations === 3) {
    try { slot.call(); } catch (error) { slot.neighborError = error.message; }
  }
}
`,
    },
    async ({ install, inspect }) => {
      await install(npmInstall("sha512-authority", "2026-10-20T00:00:00.000Z"));
      const retired = await inspect("main");
      const replacement = await inspect("main");
      let neighbor: Awaited<ReturnType<typeof inspect>> | undefined;
      try {
        // SAFETY: The fixture module initializes this slot during its first evaluation.
        const slot = (globalThis as Record<symbol, AuthoritySlot>)[authority]!;
        expect(retired.registry.plugins[0]).toMatchObject({ origin: "global", status: "loaded" });
        expect(slot).toMatchObject({ evaluations: 1, registrations: 2 });
        await retired.release();

        neighbor = await inspect("research");
        expect(slot).toMatchObject({ evaluations: 2, registrations: 3 });
        expect(slot.neighborError).toContain("calling workspace generation");

        slot.gate.resolve();
        await expect(slot.stale).rejects.toThrow("calling workspace generation");
        expect(slot.effects).toBe(0);
        expect(providers(replacement.registry)).toEqual(["fixture-provider:Fixture"]);
        expect(providers(neighbor.registry)).toEqual(["fixture-provider:Fixture"]);
      } finally {
        await neighbor?.release();
        await replacement.release();
        await retired.release();
      }
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
      async ({ pluginDir, install, inspect }) => {
        await install(before);
        const first = await inspect("main");
        try {
          expect(providers(first.registry)).toEqual(["fixture-provider:before"]);
          fs.writeFileSync(path.join(pluginDir, "label.mjs"), 'export const label = "after";');
          await install(after);
          const second = await inspect("main");
          try {
            expect(providers(second.registry)).toEqual(["fixture-provider:after"]);
          } finally {
            await second.release();
          }
        } finally {
          await first.release();
        }
      },
    );
  },
  120_000,
);
