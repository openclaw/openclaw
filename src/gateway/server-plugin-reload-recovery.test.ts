import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { waitForFile } from "../../test/helpers/process-wait.js";
import { withRuntimePreload } from "../../test/helpers/runtime-preload.js";
import { closeDefaultRetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import { loadOpenClawPluginsAsync } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import * as preparation from "../plugins/plugin-generation-worker.js";
import { withPluginSourceCaptureStorage } from "../plugins/plugin-source-capture-context.js";
import {
  PLUGIN_SOURCE_CAPTURE_PREFIX,
  resolvePluginSourceCapturesDirectory,
} from "../plugins/plugin-source-capture-path.js";
import { withEnvAsync } from "../test-utils/env.js";
import { observeMainThreadFs } from "../test-utils/main-thread-fs-spies.test-support.js";
import { prepareGatewayPluginLoad } from "./server-plugin-bootstrap.js";
import { createPluginReloadRecovery } from "./server-plugin-reload-recovery.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

function recoveryFixture(id: string, body: string) {
  useNoBundledPlugins();
  const plugin = writePlugin({ id, body });
  let root: string | undefined;
  const prepare = preparation.preparePluginGenerationArtifact;
  vi.spyOn(preparation, "preparePluginGenerationArtifact").mockImplementation(async (params) => {
    const prepared = await prepare(params);
    root = prepared.artifact.boundaryRoot;
    return prepared;
  });
  const stateDir = makePluginLoaderTempDir();
  const caches: ReturnType<typeof createPluginCache>[] = [];
  return {
    plugin,
    stateDir,
    captures(this: void) {
      const captureParent = resolvePluginSourceCapturesDirectory(stateDir);
      return fs
        .readdirSync(captureParent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => {
          const directory = path.join(captureParent, entry.name, "captures");
          return fs.existsSync(directory)
            ? fs
                .readdirSync(directory)
                .filter((name) => name.startsWith(PLUGIN_SOURCE_CAPTURE_PREFIX))
                .map((name) => path.join(directory, name))
            : [];
        });
    },
    capturedRoot(this: void) {
      expect(root).toBeDefined();
      return root!;
    },
    load(this: void) {
      const cache = createPluginCache();
      caches.push(cache);
      return withPluginCache(cache, () =>
        loadOpenClawPluginsAsync({
          activate: false,
          config: {
            plugins: { allow: [id], load: { paths: [plugin.file] }, slots: { memory: "none" } },
          },
        }),
      );
    },
    run<T>(run: () => T) {
      return withPluginSourceCaptureStorage({ stateDir, placement: "state" }, run);
    },
    async [Symbol.asyncDispose]() {
      for (const cache of caches) {
        await retirePluginCache(cache);
      }
    },
  };
}

it("captures recovery and joins cleanup without synchronous filesystem work", async ({
  signal,
}) => {
  const gate = makePluginLoaderTempDir();
  const armed = path.join(gate, "armed");
  const ready = path.join(gate, "ready");
  const release = path.join(gate, "release");
  const receipt = path.join(gate, "copy.json");
  const preload = path.join(gate, "copy-preload.mjs");
  fs.writeFileSync(
    preload,
    `import fs from 'node:fs';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
const copy = fs.promises.cp;
let copies = 0;
fs.promises.cp = async (...args) => {
  if (fs.existsSync(${JSON.stringify(armed)}) && path.basename(String(args[1])).startsWith('openclaw-plugin-build-')) {
    fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ source: String(args[0]), destination: String(args[1]), pid: process.pid, copies: ++copies }));
    fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
    while (!fs.existsSync(${JSON.stringify(release)})) await setTimeout(5);
  }
  return copy(...args);
};\n`,
  );
  await closeDefaultRetainedNativeWorkerSource();
  try {
    await withEnvAsync(
      withRuntimePreload(
        { NODE_OPTIONS: process.env.NODE_OPTIONS, BUN_OPTIONS: process.env.BUN_OPTIONS },
        preload,
      ),
      async () => {
        await using fixture = recoveryFixture(
          "recovery-cleanup",
          'module.exports = { id: "recovery-cleanup", register(api) { api.registerProvider({ id: "recovery-provider", label: "Active", auth: [], normalizeModelId: ({ modelId }) => `active:${modelId}` }); } };',
        );
        const { plugin, load, captures, capturedRoot } = fixture;
        await fixture.run(async () => {
          const previous = await load();
          const record = previous.plugins.find(({ id }) => id === plugin.id);
          expect(record?.status, record?.error).toBe("loaded");
          const capturesBefore = captures();
          const recovery = createPluginReloadRecovery(previous, prepareGatewayPluginLoad);
          fs.writeFileSync(armed, "capture");
          using observedFs = observeMainThreadFs();
          let settled = false;
          const capturing = recovery.capture(new Set([plugin.id])).finally(() => {
            settled = true;
          });
          try {
            await waitForFile(ready, signal);
            await setImmediate();
            expect(settled).toBe(false);
            const copied: { source: string; destination: string; pid: number } = JSON.parse(
              fs.readFileSync(receipt, "utf8"),
            );
            expect(copied.pid).not.toBe(process.pid);
            expect(copied.source).toBe(capturedRoot());
            expect(copied.destination).not.toBe(copied.source);
            fs.writeFileSync(release, "continue");
            expect(await capturing).toEqual([]);
            expect(JSON.parse(fs.readFileSync(receipt, "utf8")).copies).toBe(1);
            const addedCaptures = captures().filter((entry) => !capturesBefore.includes(entry));
            expect(addedCaptures).toHaveLength(1);
            const recoveryRoot = addedCaptures[0]!;
            expect(recoveryRoot).toBe(copied.destination);
            expect(fs.existsSync(recoveryRoot)).toBe(true);
            // Native async removal can finish before a queued microtask; observe blocking work instead.
            using synchronousRemovals = vi.spyOn(fs, "rmSync");
            await recovery.dispose();
            expect(
              synchronousRemovals.mock.calls.filter(([, options]) => options?.recursive),
            ).toHaveLength(0);
            expect(
              observedFs
                .stacks()
                .filter(({ stack }) =>
                  /plugin-generation-source-lookup|plugin-recovery-source-copy|plugin-package-metadata-capture|plugin-source-capture|plugin-native-reference/.test(
                    stack,
                  ),
                ),
            ).toEqual([]);
            expect(fs.existsSync(recoveryRoot)).toBe(false);
            expect(captures()).toEqual(capturesBefore);
            expect(fs.existsSync(capturedRoot())).toBe(true);
            expect(
              previous.providers[0]!.provider.normalizeModelId!({
                provider: "recovery-provider",
                modelId: "still-callable",
              }),
            ).toBe("active:still-callable");
          } finally {
            fs.writeFileSync(release, "continue");
            try {
              await capturing;
            } finally {
              await recovery.dispose();
            }
          }
        });
      },
    );
  } finally {
    await closeDefaultRetainedNativeWorkerSource();
  }
});

it("replaces a worker-backed plugin when its previous captured source is missing", async () => {
  await using fixture = recoveryFixture(
    "missing-capture",
    'module.exports = { id: "missing-capture", register(api) { api.registerProvider({ id: "replacement", label: "Old", auth: [] }); } };',
  );
  const { plugin, load, capturedRoot, stateDir } = fixture;
  await fixture.run(async () => {
    const previous = await load();
    const record = previous.plugins.find(({ id }) => id === plugin.id);
    expect(record?.status, record?.error).toBe("loaded");
    const root = capturedRoot();
    const relativeCapture = path.relative(stateDir, root);
    expect(relativeCapture).not.toBe("");
    expect(relativeCapture.startsWith("..") || path.isAbsolute(relativeCapture)).toBe(false);
    const capturesBefore = fixture.captures();
    fs.rmSync(root, { recursive: true });
    const recovery = createPluginReloadRecovery(previous, prepareGatewayPluginLoad);
    try {
      expect(await recovery.capture(new Set([plugin.id]))).toEqual([
        `Plugin ${plugin.id} captured source is missing. Continuing replacement; rollback cannot restore this plugin's previous code.`,
      ]);
      expect([...recovery.unavailablePluginIds]).toEqual([plugin.id]);
      expect(fixture.captures()).toEqual(capturesBefore);
      fs.writeFileSync(
        plugin.file,
        'module.exports = { id: "missing-capture", register(api) { api.registerProvider({ id: "replacement", label: "New", auth: [] }); } };',
      );
      const replacement = await load();
      expect(replacement.plugins.find(({ id }) => id === plugin.id)?.status).toBe("loaded");
      expect(replacement.providers.map(({ provider }) => provider.label)).toEqual(["New"]);
    } finally {
      await recovery.dispose();
    }
  });
});
