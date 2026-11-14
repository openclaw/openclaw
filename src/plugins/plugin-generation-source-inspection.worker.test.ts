import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeDefaultRetainedNativeWorkerSource,
  captureRetainedNativeWorkerSource,
} from "../infra/worker-native-lifecycle.js";
import { withArtifactPreservingStateReads } from "../state/artifact-preserving-state-reads.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolvePluginInstallRoots, withPluginInstallRoots } from "./install-root-context.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { createFixture } from "./plugin-generation-artifact.admission.test-support.js";
import { inspectPluginGenerationSources } from "./plugin-generation-source-inspection.js";
import {
  inspectPluginGenerationSourcesAsync as inspectSources,
  inspectPluginSourceDependenciesAsync as inspectDependencies,
} from "./plugin-generation-worker.js";
import {
  nativeAdmissionStateFor,
  preparePluginNativeAdmissions,
} from "./plugin-native-admission-state.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";
import { writeArtifacts } from "./public-surface.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  await closeDefaultRetainedNativeWorkerSource();
});

async function withInspection<T>(run: () => Promise<T>) {
  const stateDir = dirs.make("plugin-inspection-state-");
  await using cache = createPluginCache();
  return await withArtifactPreservingStateReads(() =>
    withPluginCache(cache, () =>
      withPluginSourceCaptureStorage({ stateDir, placement: "temporary" }, run),
    ),
  );
}

it("inspects the selected graph without acquiring original bytes on the caller thread", async () => {
  const parent = fs.realpathSync(dirs.make("plugin-inspection-source-"));
  const rootDir = path.join(parent, "plugin");
  writeArtifacts(path.join(parent, "node_modules", "missing-inspection-package"), {
    "package.json": { main: "index.js" },
    "index.js": "module.exports = 1;",
  });
  const entryFile = path.join(rootDir, "index.mjs");
  writeArtifacts(rootDir, {
    "package.json": { type: "module" },
    "index.mjs":
      "import './dependency.mjs'; import 'missing-inspection-package'; throw new Error('must not execute');",
    "dependency.mjs": "export const value = 42;",
  });
  for (let i = 0; i < 128; i++) {
    fs.writeFileSync(path.join(rootDir, `${i}.txt`), "payload".repeat(1024));
  }
  const identity = fs.statSync(entryFile, { bigint: true });
  const read = fs.readSync;
  let sourceReads = 0;
  vi.spyOn(fs, "readSync").mockImplementation(((fd: number, ...args: unknown[]) => {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (opened.dev === identity.dev && opened.ino === identity.ino) {
      sourceReads++;
    }
    return Reflect.apply(read, fs, [fd, ...args]);
  }) as typeof fs.readSync);
  const unresolved: Array<{ name: string; importer: string }> = [];
  const result = await withInspection(() =>
    inspectDependencies([{ rootDir, entryFile }], {
      root: rootDir,
      onUnresolvable: (name, importer) => unresolved.push({ name, importer }),
    }),
  );
  expect(result.references).toEqual([
    {
      source: entryFile,
      specifier: "./dependency.mjs",
      target: path.join(rootDir, "dependency.mjs"),
    },
  ]);
  expect(unresolved).toContainEqual({ name: "missing-inspection-package", importer: entryFile });
  expect(sourceReads).toBe(0);
  expect(captureRetainedNativeWorkerSource({ runtimeGeneration: undefined }).hasActiveWorkers).toBe(
    false,
  );
});

it("keeps source digests and native admission for every selected owner", async () => {
  const parent = fs.realpathSync(dirs.make("plugin-inspection-native-"));
  const fixtures = [
    createFixture(path.join(parent, "first"), false),
    createFixture(path.join(parent, "second"), false),
  ];
  const entries = fixtures.map((fixture, index) => ({
    pluginId: `fixture-${index}`,
    rootDir: fixture.root,
  }));
  for (const [index, fixture] of fixtures.entries()) {
    fixture.index.plugins[0]!.pluginId = entries[index]!.pluginId;
  }
  const expected = await withInspection(async () => {
    for (const fixture of fixtures) {
      preparePluginNativeAdmissions(fixture.index);
    }
    return inspectPluginGenerationSources(entries);
  });
  await withOpenClawTestState({ label: "inspection-native-owners" }, async (state) => {
    const index = {
      ...fixtures[0]!.index,
      plugins: fixtures.flatMap((fixture) => fixture.index.plugins),
    };
    await writePersistedInstalledPluginIndex(index, { stateDir: state.stateDir });
    await using cache = createPluginCache();
    await withPluginCache(cache, () =>
      withPluginInstallRoots(resolvePluginInstallRoots(state.env), () =>
        withPluginSourceCaptureStorage(
          { stateDir: state.stateDir, placement: "temporary" },
          async () => {
            preparePluginNativeAdmissions(index);
            expect(await inspectSources(entries)).toEqual(expected);
            const persisted = await readPersistedInstalledPluginIndex({ stateDir: state.stateDir });
            for (const [position, fixture] of fixtures.entries()) {
              const receipt = nativeAdmissionStateFor().receipts.get(`${fixture.root}\0`);
              expect(receipt?.nativeArtifacts[fixture.filename]?.contentHash).toMatch(
                /^[a-f0-9]{64}$/,
              );
              expect(
                fs.readFileSync(receipt!.nativeArtifacts[fixture.filename]!.capturedPath),
              ).toEqual(fixture.bytes);
              expect(
                persisted?.plugins[position]?.sourceAdmissions?.[`${fixture.root}\0`]?.sourceDigest,
              ).toBe(expected.sourceDigests[entries[position]!.pluginId]);
            }
          },
        ),
      ),
    );
  });
  expect(captureRetainedNativeWorkerSource({ runtimeGeneration: undefined }).hasActiveWorkers).toBe(
    false,
  );
});

it("preserves syntax errors, callback failures and empty selections without retaining workers", async () => {
  const parent = fs.realpathSync(dirs.make("plugin-inspection-error-"));
  const rootDir = path.join(parent, "plugin");
  writeArtifacts(path.join(parent, "node_modules", "missing-inspection-package"), {
    "package.json": { main: "index.js" },
    "index.js": "module.exports = 1;",
  });
  const entryFile = path.join(rootDir, "index.mjs");
  writeArtifacts(rootDir, { "index.mjs": "const broken = /(/;" });
  await withInspection(async () => {
    await expect(inspectDependencies([{ rootDir, entryFile }])).rejects.toBeInstanceOf(SyntaxError);
    fs.writeFileSync(entryFile, "import 'missing-inspection-package';");
    await expect(
      inspectDependencies([{ rootDir, entryFile }], {
        root: rootDir,
        onUnresolvable: () => {
          throw new Error("inspection callback refused");
        },
      }),
    ).rejects.toThrow("inspection callback refused");
    expect(await inspectDependencies([])).toEqual({
      files: [],
      packageRoots: [],
      unresolved: [],
      references: [],
    });
    expect(await inspectSources([])).toEqual({ sourceDigests: {} });
    expect(
      captureRetainedNativeWorkerSource({ runtimeGeneration: undefined }).hasActiveWorkers,
    ).toBe(false);
  });
});
