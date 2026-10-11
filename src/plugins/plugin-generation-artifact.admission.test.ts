import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import * as fsSafeAdvanced from "@openclaw/fs-safe/advanced";
import { expect, it, vi, type MockInstance } from "vitest";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "./installed-plugin-index-types.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { createFixture, nativeSize } from "./plugin-generation-artifact.admission.test-support.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import {
  preparePluginNativeAdmissions,
  settlePluginNativeAdmissions,
} from "./plugin-native-admission-state.js";
import {
  auditOpenClawPeerDependenciesInManagedNpmRoot,
  relinkOpenClawPeerDependenciesInManagedNpmRoot,
} from "./plugin-peer-link.js";

vi.mock("@openclaw/fs-safe/advanced", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/advanced")>()),
}));

function observeNativeIo(filename: string) {
  const original = fs.statSync(filename);
  const readSync = fs.readSync;
  const readFileSync = fs.readFileSync;
  const copyRootFileSync = fsSafeAdvanced.copyRootFileSync;
  const createBatch = fsSafeAdvanced.createRootFileCopyBatchSync;
  const writeSync = fs.writeSync;
  const empty = () => ({ originalBytes: 0, capturedBytes: 0, wholeFileReads: 0, largestBuffer: 0 });
  let current: ReturnType<typeof empty> | undefined;
  let copies = new Set<string>();
  const recordCopy = (stat: fs.Stats) => {
    if (current && stat.size === original.size) {
      copies.add(`${stat.dev}:${stat.ino}`);
    }
  };
  const recordCopiedFile = (copied: ReturnType<typeof fsSafeAdvanced.copyRootFileSync>) => {
    if (current) {
      recordCopy(fs.fstatSync(copied.fd));
    }
    return copied;
  };
  const spies = [
    vi.spyOn(fs, "readSync").mockImplementation((...args) => {
      const length = Reflect.apply(readSync, fs, args);
      const stat = fs.fstatSync(args[0]);
      if (current && stat.size === original.size) {
        if (stat.dev === original.dev && stat.ino === original.ino) {
          current.originalBytes += length;
        } else {
          current.capturedBytes += length;
        }
        if (Buffer.isBuffer(args[1])) {
          current.largestBuffer = Math.max(current.largestBuffer, args[1].buffer.byteLength);
        }
      }
      return length;
    }),
    vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      const result = readFileSync(file, options);
      if (current && Buffer.isBuffer(result) && result.length >= original.size) {
        current.wholeFileReads += 1;
      }
      return result;
    }),
    vi
      .spyOn(fsSafeAdvanced, "copyRootFileSync")
      .mockImplementation((options) => recordCopiedFile(copyRootFileSync(options))),
    vi.spyOn(fsSafeAdvanced, "createRootFileCopyBatchSync").mockImplementation(() => {
      const batch = createBatch();
      return {
        ...batch,
        copyFile: (options) => recordCopiedFile(batch.copyFile(options)),
      };
    }),
    vi.spyOn(fs, "writeSync").mockImplementation((...args) => {
      const length = Reflect.apply(writeSync, fs, args);
      if (current) {
        recordCopy(fs.fstatSync(args[0]));
      }
      return length;
    }),
  ];
  return {
    measure<T>(run: () => T) {
      const counts = empty();
      current = counts;
      copies = new Set();
      try {
        return { value: run(), io: { ...counts, copies: copies.size } };
      } finally {
        current = undefined;
      }
    },
    async measureAsync<T>(run: () => Promise<T>) {
      const counts = empty();
      current = counts;
      copies = new Set();
      try {
        return { value: await run(), io: { ...counts, copies: copies.size } };
      } finally {
        current = undefined;
      }
    },
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}

function expectNoNativeIo(io: ReturnType<ReturnType<typeof observeNativeIo>["measure"]>["io"]) {
  expect(io).toEqual({
    originalBytes: 0,
    capturedBytes: 0,
    wholeFileReads: 0,
    largestBuffer: 0,
    copies: 0,
  });
}

async function disposeCaptures(
  artifacts: ReturnType<typeof capturePluginGenerationArtifact>[],
  caches: ReturnType<typeof createPluginCache>[],
) {
  for (const artifact of artifacts) {
    await artifact.disposeAsync();
  }
  for (const cache of caches) {
    await retirePluginCache(cache);
  }
}

it("shares first native admission across private inspections and publishes after install settlement", async () => {
  await withOpenClawTestState({ label: "native-inspection-admission" }, async (state) => {
    const fixture = createFixture(state.path("installed"), true);
    await writePersistedInstalledPluginIndex(fixture.index, { stateDir: state.stateDir });
    const parent = createPluginCache();
    const reader = createPluginCache();
    preparePluginNativeAdmissions(fixture.index, parent);
    const { acquirePluginRegistryForInspection } = await import("./loader.js");
    const observer = observeNativeIo(fixture.filename);
    try {
      await withPluginLifecycleLease({ env: state.env }, async () => {
        for (const admission of ["first", "second"]) {
          const inspection = await observer.measureAsync(() =>
            withPluginCache(parent, () =>
              acquirePluginRegistryForInspection({
                config: {
                  plugins: {
                    allow: ["fixture"],
                    load: { paths: [fixture.root] },
                    entries: { fixture: { enabled: true } },
                    slots: { memory: "none" },
                  },
                },
                installRecords: fixture.index.installRecords,
                onlyPluginIds: ["fixture"],
              }),
            ),
          );
          try {
            expect(inspection.value.registry.plugins).toContainEqual(
              expect.objectContaining({ id: "fixture", status: "loaded" }),
            );
            if (admission === "first") {
              expect(inspection.io).toMatchObject({
                originalBytes: nativeSize,
                capturedBytes: 0,
                copies: 0,
                wholeFileReads: 0,
              });
              expect(inspection.io.largestBuffer).toBeLessThanOrEqual(1024 * 1024);
            } else {
              expectNoNativeIo(inspection.io);
            }
          } finally {
            await inspection.value.release();
          }
        }
      });
      await settlePluginNativeAdmissions(parent);
      await retirePluginCache(parent);
      const persisted = await withPluginCache(reader, () =>
        readPersistedInstalledPluginIndex({ stateDir: state.stateDir }),
      );
      const receipts = Object.values(persisted?.plugins[0]?.sourceAdmissions ?? {});
      expect(receipts).toHaveLength(1);
      const native = receipts[0]!.nativeArtifacts[fixture.filename];
      expect(native?.contentHash).toBe(createHash("sha256").update(fixture.bytes).digest("hex"));
      expect(fs.readFileSync(native!.capturedPath).equals(fixture.bytes)).toBe(true);
    } finally {
      observer.restore();
      await retirePluginCache(parent);
      await retirePluginCache(reader);
    }
  });
});

it.each([false, true])(
  "requires a writable admission before publishing inspected native bytes (writable=%s)",
  async (writable) => {
    await withOpenClawTestState({ label: "native-readonly-admission" }, async (state) => {
      const fixture = createFixture(state.path("installed"), true);
      await writePersistedInstalledPluginIndex(fixture.index, { stateDir: state.stateDir });
      const cache = createPluginCache();
      try {
        await withArtifactPreservingStateReads(async () => {
          preparePluginNativeAdmissions(fixture.index, cache);
          const artifact = withPluginCache(cache, () =>
            capturePluginGenerationArtifact(fixture.root),
          );
          try {
            expect(fs.readFileSync(artifact.resolve(fixture.filename)).equals(fixture.bytes)).toBe(
              true,
            );
            await settlePluginNativeAdmissions(cache);
          } finally {
            await artifact.disposeAsync();
          }
        });
        if (writable) {
          preparePluginNativeAdmissions(fixture.index, cache);
          const artifact = withPluginCache(cache, () =>
            capturePluginGenerationArtifact(fixture.root),
          );
          await artifact.disposeAsync();
        }
      } finally {
        await retirePluginCache(cache);
      }
      await using reader = createPluginCache();
      const persisted = await withPluginCache(reader, () =>
        readPersistedInstalledPluginIndex({ stateDir: state.stateDir }),
      );
      expect(persisted?.plugins).toHaveLength(1);
      expect(Object.keys(persisted!.plugins[0]!.sourceAdmissions ?? {})).toHaveLength(
        writable ? 1 : 0,
      );
    });
  },
);

it("keeps deferred native admission publication with its original state directory", async () => {
  await withOpenClawTestState({ label: "native-publication-origin" }, async (state) => {
    const fixture = createFixture(state.path("installed"), true);
    const replacementState = state.path("replacement-state");
    for (const stateDir of [state.stateDir, replacementState]) {
      await writePersistedInstalledPluginIndex(fixture.index, { stateDir });
    }
    const cache = createPluginCache();
    preparePluginNativeAdmissions(fixture.index, cache);
    try {
      await withPluginLifecycleLease({ env: state.env }, async () => {
        const artifact = withPluginCache(cache, () =>
          capturePluginGenerationArtifact(fixture.root),
        );
        try {
          await settlePluginNativeAdmissions(cache);
        } finally {
          await artifact.disposeAsync();
        }
      });
      await withEnvAsync({ OPENCLAW_STATE_DIR: replacementState }, () => retirePluginCache(cache));
      for (const stateDir of [state.stateDir, replacementState]) {
        await using reader = createPluginCache();
        const persisted = await withPluginCache(reader, () =>
          readPersistedInstalledPluginIndex({ stateDir }),
        );
        expect(persisted?.plugins).toHaveLength(1);
        expect(Object.keys(persisted!.plugins[0]!.sourceAdmissions ?? {})).toHaveLength(
          stateDir === state.stateDir ? 1 : 0,
        );
      }
    } finally {
      await retirePluginCache(cache);
    }
  });
});

it.each(["retained", "partial"] as const)(
  "rejects missing bytes in retained or partially present native namespaces (%s)",
  async (missing) => {
    await withOpenClawTestState({ label: "native-missing-admission" }, async (state) => {
      const fixture = createFixture(state.path("installed"), true);
      fs.writeFileSync(path.join(fixture.root, "README.md"), "native companion");
      await writePersistedInstalledPluginIndex(fixture.index, { stateDir: state.stateDir });
      const firstCache = createPluginCache();
      preparePluginNativeAdmissions(fixture.index, firstCache);
      const first = withPluginCache(firstCache, () =>
        capturePluginGenerationArtifact(fixture.root),
      );
      try {
        await settlePluginNativeAdmissions(firstCache);
        if (missing !== "retained") {
          await first.disposeAsync();
          await retirePluginCache(firstCache);
        }
        await using cache = createPluginCache();
        const persisted = await withPluginCache(cache, () =>
          readPersistedInstalledPluginIndex({ stateDir: state.stateDir }),
        );
        expect(persisted).not.toBeNull();
        const receipts = Object.values(persisted!.plugins[0]!.sourceAdmissions ?? {});
        expect(receipts).toHaveLength(1);
        for (const namespace of Object.values(receipts[0]!.nativeNamespaces)) {
          fs.rmSync(
            missing === "partial"
              ? path.join(namespace.capturedRoot, "content", "README.md")
              : namespace.capturedRoot,
            { recursive: true },
          );
        }
        preparePluginNativeAdmissions(persisted!, cache);
        const capture = () =>
          withPluginCache(cache, () => capturePluginGenerationArtifact(fixture.root));
        expect(capture).toThrow("Cannot capture plugin source");
      } finally {
        await first.disposeAsync();
        await retirePluginCache(firstCache);
      }
    });
  },
);

it.each(["npm", "clawhub"] as const)(
  "admits %s native bytes once across captures and a fresh cache reading persisted receipts",
  async (source) => {
    await withOpenClawTestState({ label: "native-admission-managed" }, async (state) => {
      const fixture = createFixture(state.path("installed"), true, source);
      const dependencyRoot = path.join(fixture.installRoot, "node_modules", "native-addon");
      const dependencyManifest = path.join(dependencyRoot, "package.json");
      const dependencyNative = path.join(dependencyRoot, "addon.node");
      fs.mkdirSync(dependencyRoot, { recursive: true });
      fs.writeFileSync(
        dependencyManifest,
        JSON.stringify({ name: "native-addon", version: "1.0.0", main: "addon.node" }),
      );
      fs.writeFileSync(dependencyNative, "native dependency fixture");
      const packageFile = path.join(fixture.root, "package.json");
      fs.writeFileSync(
        packageFile,
        JSON.stringify({
          ...JSON.parse(fs.readFileSync(packageFile, "utf8")),
          dependencies: { "native-addon": "1.0.0" },
        }),
      );
      fs.writeFileSync(
        path.join(fixture.root, "child.cjs"),
        "module.exports = require('openclaw/plugin-sdk/identity');\n",
      );
      fs.writeFileSync(path.join(fixture.root, "sidecar.txt"), "native companion");
      const hosts = ["first", "second"].map((identity) => {
        const host = state.path(`host-${identity}`);
        fs.mkdirSync(host);
        fs.writeFileSync(
          path.join(host, "package.json"),
          JSON.stringify({
            name: "openclaw",
            exports: { "./plugin-sdk/identity": "./identity.cjs" },
          }),
        );
        fs.writeFileSync(
          path.join(host, "identity.cjs"),
          `module.exports = ${JSON.stringify(identity)};`,
        );
        return host;
      });
      await writePersistedInstalledPluginIndex(fixture.index, { stateDir: state.stateDir });
      const caches = [createPluginCache()];
      const artifacts: ReturnType<typeof capturePluginGenerationArtifact>[] = [];
      const observer = observeNativeIo(fixture.filename);
      const capture = (cache: ReturnType<typeof createPluginCache>, host = hosts[0]!) =>
        observer.measure(() => {
          const artifact = withPluginCache(cache, () =>
            capturePluginGenerationArtifact(fixture.root),
          );
          artifacts.push(artifact);
          artifact.linkHost(host);
          artifact.assertSourceCurrent();
          return artifact;
        });
      const assertDependencyCapture = async (
        artifact: ReturnType<typeof capturePluginGenerationArtifact>,
      ) => {
        const capturedDependency = artifact.sourceAliases[fs.realpathSync(dependencyRoot)];
        expect(capturedDependency).toBeDefined();
        const retainedNative = fs.realpathSync(path.join(capturedDependency!, "addon.node"));
        const retainedManifest = path.join(path.dirname(retainedNative), "package.json");
        const installed = fs.statSync(dependencyManifest);
        const retained = fs.statSync(retainedManifest);
        expect(installed.nlink).toBe(1);
        expect(retained.nlink).toBe(1);
        expect([retained.dev, retained.ino]).not.toEqual([installed.dev, installed.ino]);
        expect(fs.readFileSync(retainedManifest, "utf8")).toBe(
          fs.readFileSync(dependencyManifest, "utf8"),
        );
        const native = fs.statSync(dependencyNative);
        expect(fs.statSync(retainedNative)).toMatchObject({ dev: native.dev, ino: native.ino });
        const onPackageReadError = vi.fn();
        await auditOpenClawPeerDependenciesInManagedNpmRoot({
          npmRoot: fixture.installRoot,
          onPackageReadError,
        });
        await relinkOpenClawPeerDependenciesInManagedNpmRoot({
          npmRoot: fixture.installRoot,
          logger: {},
          onPackageReadError,
        });
        expect(onPackageReadError).not.toHaveBeenCalled();
      };
      try {
        const firstCache = caches[0]!;
        preparePluginNativeAdmissions(fixture.index, firstCache);
        const first = capture(firstCache);
        const retainedNativePath = fs.realpathSync(first.value.resolve(fixture.filename));
        expect(first.io).toMatchObject({
          originalBytes: nativeSize,
          capturedBytes: 0,
          copies: 0,
          wholeFileReads: 0,
        });
        expect(first.io.largestBuffer).toBeLessThanOrEqual(1024 * 1024);
        await assertDependencyCapture(first.value);
        for (let registration = 0; registration < 2; registration++) {
          const next = capture(firstCache);
          expectNoNativeIo(next.io);
          expect(next.value.sourceDigest).toBe(first.value.sourceDigest);
          expect(fs.realpathSync(next.value.resolve(fixture.filename))).toBe(retainedNativePath);
        }
        for (const artifact of artifacts.splice(0)) {
          await artifact.disposeAsync();
        }
        await retirePluginCache(firstCache);

        const freshCache = createPluginCache();
        caches.push(freshCache);
        const persisted = await withPluginCache(freshCache, () =>
          readPersistedInstalledPluginIndex({ stateDir: state.stateDir }),
        );
        if (!persisted) {
          throw new Error("Native admission did not persist its installed index");
        }
        const receipts = Object.values(persisted.plugins[0]!.sourceAdmissions ?? {});
        expect(receipts).toHaveLength(1);
        expect(receipts[0]!.nativeArtifacts[fixture.filename]?.contentHash).toBe(
          createHash("sha256").update(fixture.bytes).digest("hex"),
        );
        preparePluginNativeAdmissions(persisted, freshCache);
        const warm = capture(freshCache);
        expectNoNativeIo(warm.io);
        await assertDependencyCapture(warm.value);
        expect(warm.value.sourceDigest).toBe(first.value.sourceDigest);
        expect(fs.realpathSync(warm.value.resolve(fixture.filename))).toBe(retainedNativePath);
        expect(fs.readFileSync(warm.value.resolve(fixture.filename)).equals(fixture.bytes)).toBe(
          true,
        );
        // A native executable resolves a sibling helper from its real installed image path.
        const readChildSdk = (artifact: ReturnType<typeof capturePluginGenerationArtifact>) => {
          const native = fs.realpathSync(artifact.resolve(fixture.filename));
          return createRequire(native)(path.join(path.dirname(native), "child.cjs"));
        };
        expect(readChildSdk(warm.value)).toBe("first");
        for (const companion of ["child.cjs", "sidecar.txt"]) {
          const installedPath = path.join(fixture.root, companion);
          const retainedPath = path.join(
            path.dirname(fs.realpathSync(warm.value.resolve(fixture.filename))),
            companion,
          );
          const installed = fs.statSync(installedPath);
          const retained = fs.statSync(retainedPath);
          if (companion === "child.cjs") {
            // Public-surface files retain the existing independent-copy safety contract.
            expect(installed.nlink).toBe(1);
            expect([retained.dev, retained.ino]).not.toEqual([installed.dev, installed.ino]);
          } else {
            expect(retained).toMatchObject({ dev: installed.dev, ino: installed.ino });
          }
          expect(fs.readFileSync(retainedPath, "utf8")).toBe(
            fs.readFileSync(installedPath, "utf8"),
          );
        }
        const { loadPluginRegistryHandle } = await import("./loader.js");
        const { resolvePluginMetadataSnapshotAsync } =
          await import("./plugin-metadata-snapshot.js");
        const config = {
          plugins: {
            allow: ["fixture"],
            load: { paths: [fixture.root] },
            entries: { fixture: { enabled: true } },
            slots: { memory: "none" },
          },
        };
        const loadRuntime = (
          cache: ReturnType<typeof createPluginCache>,
          index: InstalledPluginIndex,
        ) =>
          observer.measure(() =>
            withPluginCache(cache, () =>
              loadPluginRegistryHandle({
                config,
                installRecords: index.installRecords,
                onlyPluginIds: ["fixture"],
              }),
            ),
          );
        const successor = capture(freshCache, hosts[1]);
        expect(successor.io).toMatchObject({
          originalBytes: nativeSize,
          capturedBytes: 0,
          copies: 0,
          wholeFileReads: 0,
        });
        expect(successor.value.sourceDigest).toBe(warm.value.sourceDigest);
        await assertDependencyCapture(successor.value);
        expect(readChildSdk(successor.value)).toBe("second");
        expect(readChildSdk(warm.value)).toBe("first");
        expect(
          fs.realpathSync(
            path.join(
              receipts[0]!.nativeNamespaces[
                receipts[0]!.nativeArtifacts[fixture.filename]!.namespace
              ]!.capturedRoot,
              "node_modules",
              "openclaw",
            ),
          ),
        ).toBe(fs.realpathSync(hosts[0]!));
        expect(() => warm.value.assertSourceCurrent()).not.toThrow();

        // Real discovery keeps the manifest and executable-entry hardlink policy intact.
        expect(loadRuntime(freshCache, persisted).value.plugins).toContainEqual(
          expect.objectContaining({ id: "fixture", status: "loaded", source: fixture.entry }),
        );
        for (const artifact of artifacts.splice(0)) {
          await artifact.disposeAsync();
        }
        await retirePluginCache(freshCache);
        const runtimeCache = createPluginCache();
        caches.push(runtimeCache);
        // Cold startup must recover receipts through metadata even when policy is re-derived.
        const runtime = await observer.measureAsync(() =>
          withPluginCache(runtimeCache, async () => {
            const snapshot = await resolvePluginMetadataSnapshotAsync({
              config,
              env: state.env,
              stateDir: state.stateDir,
            });
            return loadPluginRegistryHandle({
              config,
              manifestRegistry: snapshot.manifestRegistry,
              installRecords: snapshot.index.installRecords,
              onlyPluginIds: ["fixture"],
            });
          }),
        );
        expect(runtime.value.plugins).toContainEqual(
          expect.objectContaining({ id: "fixture", status: "loaded", source: fixture.entry }),
        );
        expectNoNativeIo(runtime.io);
      } finally {
        observer.restore();
        await disposeCaptures(artifacts, caches);
      }
    });
  },
);

it.each([false, true])(
  "admits native source with an unavailable persisted capture (unrelated=%s)",
  async (unrelated) => {
    await withOpenClawTestState({ label: "native-admission-missing-capture" }, async (state) => {
      const fixture = createFixture(state.path("installed"), true);
      const companion = path.join(fixture.root, "README.md");
      fs.writeFileSync(companion, "unchanged native companion");
      const modifiedAt = new Date(1_000);
      fs.utimesSync(companion, modifiedAt, modifiedAt);
      await writePersistedInstalledPluginIndex(fixture.index, { stateDir: state.stateDir });
      const caches = [createPluginCache(), createPluginCache()];
      const artifacts: ReturnType<typeof capturePluginGenerationArtifact>[] = [];
      const statSync = fs.statSync;
      const lstatSync = fs.lstatSync;
      let fault: MockInstance<typeof fs.statSync> | undefined;
      let rootFault: MockInstance<typeof fs.lstatSync> | undefined;
      try {
        preparePluginNativeAdmissions(fixture.index, caches[0]!);
        const first = withPluginCache(caches[0]!, () =>
          capturePluginGenerationArtifact(fixture.root),
        );
        artifacts.push(first);
        await settlePluginNativeAdmissions(caches[0]!);
        await first.disposeAsync();
        await retirePluginCache(caches[0]!);
        const persisted = await readPersistedInstalledPluginIndex({ stateDir: state.stateDir });
        const receipts = Object.values(persisted!.plugins[0]!.sourceAdmissions ?? {});
        expect(receipts).toHaveLength(1);
        const namespaces = Object.values(receipts[0]!.nativeNamespaces);
        const candidate = unrelated ? createFixture(state.path("unrelated"), false) : fixture;
        const candidateCompanion = path.join(candidate.root, "README.md");
        if (unrelated) {
          fs.writeFileSync(candidateCompanion, "unchanged native companion");
          fs.utimesSync(candidateCompanion, modifiedAt, modifiedAt);
          const inaccessible = Object.assign(new Error("Unrelated capture is inaccessible"), {
            code: "EACCES",
          });
          fault = vi.spyOn(fs, "statSync").mockImplementation((...args) => {
            if (
              namespaces.some(
                (namespace) => args[0] === path.join(namespace.capturedRoot, "content"),
              )
            ) {
              throw inaccessible;
            }
            return Reflect.apply(statSync, fs, args);
          });
          rootFault = vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
            if (namespaces.some((namespace) => args[0] === namespace.capturedRoot)) {
              throw inaccessible;
            }
            return Reflect.apply(lstatSync, fs, args);
          });
        } else {
          for (const namespace of namespaces) {
            fs.rmSync(namespace.capturedRoot, { recursive: true });
          }
        }

        preparePluginNativeAdmissions(persisted!, caches[1]!);
        const replacement = withPluginCache(caches[1]!, () =>
          capturePluginGenerationArtifact(candidate.root),
        );
        artifacts.push(replacement);
        expect(replacement.assertSourceCurrent).not.toThrow();
        expect(
          fs.readFileSync(replacement.resolve(candidate.filename)).equals(candidate.bytes),
        ).toBe(true);
        expect(fs.readFileSync(replacement.resolve(candidateCompanion), "utf8")).toBe(
          "unchanged native companion",
        );
        fs.writeFileSync(candidateCompanion, "different native companion");
        fs.utimesSync(candidateCompanion, modifiedAt, modifiedAt);
        expect(replacement.assertSourceCurrent).toThrow("Plugin source changed");
      } finally {
        rootFault?.mockRestore();
        fault?.mockRestore();
        await disposeCaptures(artifacts, caches);
      }
    });
  },
);

it.each(["direct", "transitive"] as const)(
  "keeps %s native companions current across independent cache admissions",
  async (ownership) => {
    await withOpenClawTestState({ label: `native-admission-${ownership}` }, async (state) => {
      const fixture = createFixture(state.path("installed"), true);
      const transitive = ownership === "transitive";
      if (transitive) {
        fs.unlinkSync(fixture.filename);
        const manifestPath = path.join(fixture.root, "package.json");
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        const dependencies = { "native-a": "1.0.0", "native-b": "1.0.0" };
        fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, dependencies }));
        for (const name of [...Object.keys(dependencies), "common"]) {
          const dependencyRoot = path.join(fixture.root, "node_modules", name);
          fs.mkdirSync(dependencyRoot, { recursive: true });
          fs.writeFileSync(
            path.join(dependencyRoot, "package.json"),
            JSON.stringify({
              name,
              version: "1.0.0",
              ...(name === "common" ? {} : { dependencies: { common: "1.0.0" } }),
            }),
          );
          if (name !== "common") {
            fs.writeFileSync(path.join(dependencyRoot, "fixture.bin"), "native fixture");
          }
        }
      }
      const companion = path.join(
        fixture.root,
        transitive ? "node_modules/common/a-companion.txt" : "lib/companion.cjs",
      );
      const original = transitive ? "unchanged native companion" : "module.exports = 'original';\n";
      const modifiedAt = new Date(1_000);
      fs.mkdirSync(path.dirname(companion), { recursive: true });
      fs.writeFileSync(companion, original);
      if (transitive) {
        fs.utimesSync(companion, modifiedAt, modifiedAt);
      }
      await writePersistedInstalledPluginIndex(fixture.index, { stateDir: state.stateDir });
      const caches = [createPluginCache(), createPluginCache()];
      const artifacts: ReturnType<typeof capturePluginGenerationArtifact>[] = [];
      const capture = (cache: ReturnType<typeof createPluginCache>) => {
        // Independent readers can begin from the same index before either publishes its receipt.
        preparePluginNativeAdmissions(fixture.index, cache);
        const artifact = withPluginCache(cache, () =>
          capturePluginGenerationArtifact(fixture.root),
        );
        artifacts.push(artifact);
        return artifact;
      };
      try {
        const first = capture(caches[0]!);
        if (!transitive) {
          expect(fs.readFileSync(first.resolve(companion), "utf8")).toBe(original);
          expect(first.assertSourceCurrent).not.toThrow();
        }
        const second = capture(caches[1]!);
        if (!transitive) {
          for (const artifact of [first, second]) {
            expect(fs.readFileSync(artifact.resolve(companion), "utf8")).toBe(original);
            expect(fs.readFileSync(artifact.resolve(fixture.filename)).equals(fixture.bytes)).toBe(
              true,
            );
            expect(artifact.assertSourceCurrent).not.toThrow();
          }
        } else {
          expect(first.assertSourceCurrent).not.toThrow();
        }
        const capturedCompanion = transitive
          ? createRequire(
              createRequire(first.resolve(fixture.entry)).resolve("native-a/package.json"),
            ).resolve("common/a-companion.txt")
          : undefined;
        fs.writeFileSync(
          companion,
          transitive ? "different native companion" : "module.exports = 'modified';\n",
        );
        if (transitive) {
          fs.utimesSync(companion, modifiedAt, modifiedAt);
        }
        expect(first.assertSourceCurrent).toThrow("Plugin source changed");
        expect(fs.readFileSync(capturedCompanion ?? first.resolve(companion), "utf8")).toBe(
          original,
        );
      } finally {
        await disposeCaptures(artifacts, caches);
      }
    });
  },
);

it.each([false, true])(
  "captures managed native packages that share a companion dependency (copied=%s)",
  async (copied) => {
    await withOpenClawTestState({ label: "native-shared-companion" }, async (state) => {
      const fixture = createFixture(state.path("installed"), true);
      fs.rmSync(fixture.filename);
      fs.writeFileSync(
        path.join(fixture.root, "package.json"),
        JSON.stringify({ dependencies: { "a-library": "1.0.0", "b-addon": "1.0.0" } }),
      );
      if (copied) {
        const manifest = JSON.stringify({
          id: "fixture",
          configSchema: { type: "object" },
          providerCatalogEntry: "node_modules/a-library/lib/library.so",
        });
        fs.writeFileSync(fixture.index.plugins[0]!.manifestPath, manifest);
        fixture.index.plugins[0]!.manifestHash = createHash("sha256")
          .update(manifest)
          .digest("hex");
      }
      const files = {
        "a-library/package.json": '{"name":"a-library","version":"1.0.0","main":"lib/helper.cjs"}',
        "a-library/lib/library.so": "native library bytes",
        "a-library/lib/helper.cjs": "module.exports = 'companion';",
        "b-addon/package.json": JSON.stringify({
          name: "b-addon",
          main: "lib/addon.node",
          dependencies: { "a-library": "1.0.0" },
        }),
        "b-addon/lib/addon.node": "native addon bytes",
        "c-addon/package.json": JSON.stringify({
          name: "c-addon",
          dependencies: { "a-library": "1.0.0" },
        }),
        "c-addon/lib/addon.node": "another native addon",
      };
      for (const [name, content] of Object.entries(files)) {
        const filename = path.join(fixture.root, "node_modules", name);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, content);
      }
      const cache = createPluginCache();
      preparePluginNativeAdmissions(fixture.index, cache);
      const library = path.join(fixture.root, "node_modules/a-library/lib/library.so");
      const timestamp = new Date("2020-01-01T00:00:00Z");
      fs.utimesSync(library, timestamp, timestamp);
      let artifact: ReturnType<typeof capturePluginGenerationArtifact> | undefined;
      let sibling: ReturnType<typeof capturePluginGenerationArtifact> | undefined;
      try {
        artifact = withPluginCache(cache, () => capturePluginGenerationArtifact(fixture.root));
        artifact.assertSourceCurrent();
        const require = createRequire(path.join(artifact.rootDir, "index.js"));
        expect(require("a-library")).toBe("companion");
        expect(fs.readFileSync(require.resolve("a-library/lib/library.so"), "utf8")).toBe(
          "native library bytes",
        );
        const retained = fs.statSync(require.resolve("a-library/lib/library.so"), { bigint: true });
        const installed = fs.statSync(library, { bigint: true });
        expect(retained.dev === installed.dev && retained.ino === installed.ino).toBe(!copied);
        fs.writeFileSync(library, "edited library bytes");
        fs.utimesSync(library, timestamp, timestamp);
        expect(fs.statSync(library, { bigint: true })).toMatchObject({
          dev: installed.dev,
          ino: installed.ino,
          size: installed.size,
          mtimeNs: installed.mtimeNs,
        });
        expect(() => {
          sibling = withPluginCache(cache, () =>
            capturePluginGenerationArtifact(path.join(fixture.root, "node_modules/c-addon")),
          );
        }).toThrow("Native plugin companion changed during admission");
        expect(artifact.assertSourceCurrent).toThrow("Plugin source changed");
      } finally {
        await sibling?.disposeAsync();
        await artifact?.disposeAsync();
        await retirePluginCache(cache);
      }
    });
  },
);

it("snapshots a mutable native edit once while retained generations keep their previous bytes", async () => {
  await withOpenClawTestState({ label: "native-admission-mutable" }, async (state) => {
    const fixture = createFixture(state.path("source"), false);
    const helper = path.join(fixture.root, "helper.cjs");
    fs.writeFileSync(helper, "module.exports = 'original helper';");
    await writePersistedInstalledPluginIndex(fixture.index, { stateDir: state.stateDir });
    const cache = createPluginCache();
    preparePluginNativeAdmissions(fixture.index, cache);
    const artifacts: ReturnType<typeof capturePluginGenerationArtifact>[] = [];
    const observer = observeNativeIo(fixture.filename);
    const capture = () =>
      observer.measure(() => {
        const artifact = withPluginCache(cache, () =>
          capturePluginGenerationArtifact(fixture.root),
        );
        artifacts.push(artifact);
        return artifact;
      });
    try {
      const first = capture();
      expect(first.io.copies).toBe(1);
      expect(first.io.capturedBytes).toBe(nativeSize);
      expect(first.io.wholeFileReads).toBe(0);
      expect(first.io.largestBuffer).toBeLessThanOrEqual(1024 * 1024);
      const readHelper = (artifact: ReturnType<typeof capturePluginGenerationArtifact>) =>
        fs.readFileSync(
          path.join(
            path.dirname(fs.realpathSync(artifact.resolve(fixture.filename))),
            "helper.cjs",
          ),
          "utf8",
        );
      expect(readHelper(first.value)).toBe("module.exports = 'original helper';");

      const before = fs.statSync(fixture.filename);
      const changedBytes = Buffer.alloc(nativeSize, "B");
      fs.writeFileSync(fixture.filename, changedBytes);
      fs.writeFileSync(helper, "module.exports = 'replacement helper';");
      fs.utimesSync(fixture.filename, before.atime, new Date(before.mtimeMs + 1000));
      expect(fs.statSync(fixture.filename).ino).toBe(before.ino);
      expect(first.value.assertSourceCurrent).toThrow("Plugin source changed");
      const changed = capture();
      expect(changed.io.copies).toBe(1);
      expect(changed.io.capturedBytes).toBe(nativeSize);
      expect(changed.io.wholeFileReads).toBe(0);
      expect(changed.io.largestBuffer).toBeLessThanOrEqual(1024 * 1024);
      expect(changed.value.sourceDigest).not.toBe(first.value.sourceDigest);

      const unchanged = capture();
      expectNoNativeIo(unchanged.io);
      expect(unchanged.value.sourceDigest).toBe(changed.value.sourceDigest);
      expect(fs.readFileSync(first.value.resolve(fixture.filename)).equals(fixture.bytes)).toBe(
        true,
      );
      expect(fs.readFileSync(changed.value.resolve(fixture.filename)).equals(changedBytes)).toBe(
        true,
      );
      expect(readHelper(first.value)).toBe("module.exports = 'original helper';");
      expect(readHelper(changed.value)).toBe("module.exports = 'replacement helper';");

      // A companion edit must replace the namespace even when the native inode is unchanged.
      fs.writeFileSync(helper, "module.exports = 'helper-only edit';");
      const helperChanged = capture();
      expect(helperChanged.io.copies).toBeLessThanOrEqual(1);
      expect(helperChanged.io.capturedBytes).toBe(nativeSize);
      expect(helperChanged.io.wholeFileReads).toBe(0);
      expect(helperChanged.io.largestBuffer).toBeLessThanOrEqual(1024 * 1024);
      expect(readHelper(helperChanged.value)).toBe("module.exports = 'helper-only edit';");
      expect(readHelper(changed.value)).toBe("module.exports = 'replacement helper';");
      expect(
        fs.readFileSync(helperChanged.value.resolve(fixture.filename)).equals(changedBytes),
      ).toBe(true);
      expectNoNativeIo(capture().io);
    } finally {
      observer.restore();
      await disposeCaptures(artifacts, [cache]);
    }
  });
});
