import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, it, vi, type MockInstance } from "vitest";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { createFixture, nativeSize } from "./plugin-generation-artifact.admission.test-support.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import {
  captureResources,
  createSdkHost,
  observeFileIo,
  expectBytes,
  readText,
  type Artifact,
  type Cache,
} from "./plugin-generation-capture.test-support.js";
import { withPluginGenerationSourceCustody } from "./plugin-generation-source-lookup.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import {
  preparePluginNativeAdmissions,
  settlePluginNativeAdmissions,
} from "./plugin-native-admission-state.js";
import {
  auditOpenClawPeerDependenciesInManagedNpmRoot,
  relinkOpenClawPeerDependenciesInManagedNpmRoot,
} from "./plugin-peer-link.js";
import { withPluginSourceAdmissionPublisher } from "./plugin-source-admission-context.js";
import { createPluginSourceAdmissionPublisher } from "./plugin-source-admission-store.js";
import type { PluginSourceAdmissionReceipt } from "./plugin-source-admission.types.js";
import { writeArtifacts as writeTree } from "./public-surface.test-support.js";

vi.mock("@openclaw/fs-safe/advanced", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/advanced")>()),
}));

type NativeIo = ReturnType<ReturnType<typeof observeFileIo>["measure"]>["io"];

function expectNoNativeIo(io: NativeIo) {
  expect(io).toEqual({
    originalBytes: 0,
    capturedBytes: 0,
    wholeFileReads: 0,
    largestBuffer: 0,
    copies: 0,
  });
}

function expectNativeCopy(io: NativeIo, exact = true) {
  expect(io).toMatchObject({ capturedBytes: nativeSize, wholeFileReads: 0 });
  if (exact) {
    expect(io.copies).toBe(1);
  } else {
    expect(io.copies).toBeLessThanOrEqual(1);
  }
  expect(io.largestBuffer).toBeLessThanOrEqual(1024 * 1024);
}

function readIndex(cache: Cache, stateDir: string) {
  return withPluginCache(cache, () => readPersistedInstalledPluginIndex({ stateDir }));
}

function fixtureConfig(root: string) {
  return {
    plugins: {
      allow: ["fixture"],
      load: { paths: [root] },
      entries: { fixture: { enabled: true } },
      slots: { memory: "none" },
    },
  };
}

it("shares first native admission across private inspections and publishes after install settlement", async () => {
  await withOpenClawTestState({ label: "native-inspection-admission" }, async (state) => {
    await using resources = captureResources();
    const fixture = createFixture(state.path("installed"), true);
    await writePersistedInstalledPluginIndex(fixture.index, { stateDir: state.stateDir });
    const parent = resources.cache();
    const reader = resources.cache();
    preparePluginNativeAdmissions(fixture.index, parent);
    const { acquirePluginRegistryForInspection } = await import("./loader.js");
    const publish = createPluginSourceAdmissionPublisher({ stateDir: state.stateDir });
    const receipts: PluginSourceAdmissionReceipt[] = [];
    let firstReceipt: PluginSourceAdmissionReceipt | undefined;

    await withPluginSourceAdmissionPublisher(
      async (publication) => {
        receipts.push(structuredClone(publication.receipt));
        return (await publish?.(publication)) ?? false;
      },
      () =>
        withPluginLifecycleLease({ env: state.env }, async () => {
          for (const admission of ["first", "second"]) {
            const inspection = await withPluginCache(parent, () =>
              acquirePluginRegistryForInspection({
                config: fixtureConfig(fixture.root),
                installRecords: fixture.index.installRecords,
                onlyPluginIds: ["fixture"],
              }),
            );
            try {
              expect(inspection.registry.plugins).toContainEqual(
                expect.objectContaining({ id: "fixture", status: "loaded" }),
              );
              if (admission === "first") {
                expect(receipts.length).toBeGreaterThan(0);
                firstReceipt = receipts.at(-1)!;
              } else {
                const firstNative = firstReceipt!.nativeArtifacts[fixture.filename]!;
                expect(receipts.at(-1)?.nativeArtifacts[fixture.filename]).toMatchObject({
                  capturedPath: firstNative.capturedPath,
                  namespace: firstNative.namespace,
                  contentHash: firstNative.contentHash,
                  sizeBytes: firstNative.sizeBytes,
                });
                expect(Object.keys(receipts.at(-1)!.nativeNamespaces)).toEqual(
                  Object.keys(firstReceipt!.nativeNamespaces),
                );
              }
              const native = receipts.at(-1)!.nativeArtifacts[fixture.filename]!;
              expectBytes(native.capturedPath, fixture.bytes);
            } finally {
              await inspection.release();
            }
          }
        }),
    );
    await settlePluginNativeAdmissions(parent);
    await retirePluginCache(parent);
    const persisted = await readIndex(reader, state.stateDir);
    const persistedReceipts = Object.values(persisted?.plugins[0]?.sourceAdmissions ?? {});
    expect(persistedReceipts).toHaveLength(1);
    const native = persistedReceipts[0]!.nativeArtifacts[fixture.filename];
    expect(native?.contentHash).toBe(createHash("sha256").update(fixture.bytes).digest("hex"));
    expectBytes(native!.capturedPath, fixture.bytes);
  });
});

it.each([false, true])(
  "requires a writable admission before publishing inspected native bytes (writable=%s)",
  async (writable) => {
    await withOpenClawTestState({ label: "native-readonly-admission" }, async (state) => {
      await using resources = captureResources();
      const fixture = createFixture(state.path("installed"), true);
      await writePersistedInstalledPluginIndex(fixture.index, { stateDir: state.stateDir });
      const cache = resources.cache();
      try {
        await withArtifactPreservingStateReads(async () => {
          preparePluginNativeAdmissions(fixture.index, cache);
          const artifact = resources.capture(cache, fixture.root);
          try {
            expectBytes(artifact.resolve(fixture.filename), fixture.bytes);
            await settlePluginNativeAdmissions(cache);
          } finally {
            await artifact.disposeAsync();
          }
        });
        if (writable) {
          preparePluginNativeAdmissions(fixture.index, cache);
          const artifact = resources.capture(cache, fixture.root);
          await artifact.disposeAsync();
        }
      } finally {
        await retirePluginCache(cache);
      }
      await using reader = resources.cache();
      const persisted = await readIndex(reader, state.stateDir);
      expect(persisted?.plugins).toHaveLength(1);
      expect(Object.keys(persisted!.plugins[0]!.sourceAdmissions ?? {})).toHaveLength(
        writable ? 1 : 0,
      );
    });
  },
);

it("keeps deferred native admission publication with its original state directory", async () => {
  await withOpenClawTestState({ label: "native-publication-origin" }, async (state) => {
    await using resources = captureResources();
    const fixture = createFixture(state.path("installed"), true);
    const replacementState = state.path("replacement-state");
    for (const stateDir of [state.stateDir, replacementState]) {
      await writePersistedInstalledPluginIndex(fixture.index, { stateDir });
    }
    const cache = resources.cache();
    preparePluginNativeAdmissions(fixture.index, cache);
    try {
      await withPluginLifecycleLease({ env: state.env }, async () => {
        const artifact = resources.capture(cache, fixture.root);
        try {
          await settlePluginNativeAdmissions(cache);
        } finally {
          await artifact.disposeAsync();
        }
      });
      await withEnvAsync({ OPENCLAW_STATE_DIR: replacementState }, () => retirePluginCache(cache));
      for (const stateDir of [state.stateDir, replacementState]) {
        await using reader = resources.cache();
        const persisted = await readIndex(reader, stateDir);
        expect(persisted?.plugins).toHaveLength(1);
        expect(Object.keys(persisted!.plugins[0]!.sourceAdmissions ?? {})).toHaveLength(
          stateDir === state.stateDir ? 1 : 0,
        );
      }
    } finally {
      await retirePluginCache(cache);
      // The fixture owns this second database in addition to its primary state directory.
      await closeOpenClawStateDatabaseByPathAsync(
        resolveOpenClawStateSqlitePath({ ...state.env, OPENCLAW_STATE_DIR: replacementState }),
      );
    }
  });
});

it("pins a custody fork's publisher before deferred native materialization", async () => {
  await withOpenClawTestState({ label: "native-custody-publisher" }, async (state) => {
    await using resources = captureResources();
    const fixture = createFixture(state.path("installed"), true);
    await writePersistedInstalledPluginIndex(fixture.index, { stateDir: state.stateDir });
    const cache = resources.cache();
    preparePluginNativeAdmissions(fixture.index, cache);
    const publish = createPluginSourceAdmissionPublisher({ stateDir: state.stateDir });
    const original = vi.fn(
      async (publication: Parameters<NonNullable<typeof publish>>[0]) =>
        (await publish?.(publication)) ?? false,
    );
    const replacement = vi.fn(async () => false);
    await withPluginCache(cache, () =>
      withPluginGenerationSourceCustody(async () => {
        const artifact = resources.keep(
          withPluginSourceAdmissionPublisher(original, () =>
            capturePluginGenerationArtifact(fixture.root, fixture.entry, (run) => run()),
          ),
        );
        expect(original).not.toHaveBeenCalled();
        await withPluginSourceAdmissionPublisher(replacement, async () => {
          const captured = artifact.captureResolvedModule(fixture.filename);
          expect(captured).toBeDefined();
          expectBytes(captured!, fixture.bytes);
          await settlePluginNativeAdmissions(cache);
        });
        expect(original).toHaveBeenCalledTimes(1);
        expect(replacement).not.toHaveBeenCalled();
      }),
    );
    const persisted = await readIndex(resources.cache(), state.stateDir);
    expect(Object.keys(persisted!.plugins[0]!.sourceAdmissions ?? {})).toHaveLength(1);
  });
});

it.each(["retained", "partial"] as const)(
  "rejects missing bytes in retained or partially present native namespaces (%s)",
  async (missing) => {
    await withOpenClawTestState({ label: "native-missing-admission" }, async (state) => {
      await using resources = captureResources();
      const fixture = createFixture(state.path("installed"), true);
      writeTree(fixture.root, { "README.md": "native companion" });
      await writePersistedInstalledPluginIndex(fixture.index, { stateDir: state.stateDir });
      const firstCache = resources.cache();
      preparePluginNativeAdmissions(fixture.index, firstCache);
      const first = resources.capture(firstCache, fixture.root);

      await settlePluginNativeAdmissions(firstCache);
      if (missing !== "retained") {
        await first.disposeAsync();
        await retirePluginCache(firstCache);
      }
      await using cache = resources.cache();
      const persisted = await readIndex(cache, state.stateDir);
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
      const capture = () => resources.capture(cache, fixture.root);
      expect(capture).toThrow("Cannot capture plugin source");
    });
  },
);

it.each(["npm", "clawhub"] as const)(
  "admits %s native bytes once across captures and a fresh cache reading persisted receipts",
  async (source) => {
    await withOpenClawTestState({ label: "native-admission-managed" }, async (state) => {
      await using resources = captureResources();
      const fixture = createFixture(state.path("installed"), true, source);
      const dependencyRoot = path.join(fixture.installRoot, "node_modules", "native-addon");
      const dependencyManifest = path.join(dependencyRoot, "package.json");
      const dependencyNative = path.join(dependencyRoot, "addon.node");
      writeTree(dependencyRoot, {
        "package.json": { name: "native-addon", version: "1.0.0", main: "addon.node" },
        "addon.node": "native dependency fixture",
      });
      const packageFile = path.join(fixture.root, "package.json");
      fs.writeFileSync(
        packageFile,
        JSON.stringify({
          ...JSON.parse(readText(packageFile)),
          dependencies: { "native-addon": "1.0.0" },
        }),
      );
      writeTree(fixture.root, {
        "child.cjs": "module.exports = require('openclaw/plugin-sdk/identity');\n",
        "sidecar.txt": "native companion",
      });
      const hosts = ["first", "second"].map((id) => createSdkHost(state.path(`host-${id}`), id));
      await writePersistedInstalledPluginIndex(fixture.index, { stateDir: state.stateDir });
      const firstCache = resources.cache();
      const observer = observeFileIo(fixture.filename);
      const capture = (cache: Cache, host = hosts[0]!) =>
        observer.measure(() => {
          const artifact = resources.capture(cache, fixture.root);
          artifact.linkHost(host);
          return artifact;
        });
      const expectLinkedIo = (io: NativeIo) =>
        expect(io).toMatchObject({
          originalBytes: nativeSize,
          capturedBytes: 0,
          copies: 0,
          wholeFileReads: 0,
        });
      const assertDependencyCapture = async (artifact: Artifact) => {
        const capturedDependency = artifact.sourceAliases[fs.realpathSync(dependencyRoot)];
        expect(capturedDependency).toBeDefined();
        const retainedNative = fs.realpathSync(path.join(capturedDependency!, "addon.node"));
        const retainedManifest = path.join(path.dirname(retainedNative), "package.json");
        const installed = fs.statSync(dependencyManifest);
        const retained = fs.statSync(retainedManifest);
        expect([installed.nlink, retained.nlink]).toEqual([1, 1]);
        expect([retained.dev, retained.ino]).not.toEqual([installed.dev, installed.ino]);
        expect(readText(retainedManifest)).toBe(readText(dependencyManifest));
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
        preparePluginNativeAdmissions(fixture.index, firstCache);
        const first = capture(firstCache);
        const retainedNativePath = fs.realpathSync(first.value.resolve(fixture.filename));
        expectLinkedIo(first.io);
        expect(first.io.largestBuffer).toBeLessThanOrEqual(1024 * 1024);
        await assertDependencyCapture(first.value);
        for (let registration = 0; registration < 2; registration++) {
          const next = capture(firstCache);
          expectNoNativeIo(next.io);
          expect(next.value.sourceDigest).toBe(first.value.sourceDigest);
          expect(fs.realpathSync(next.value.resolve(fixture.filename))).toBe(retainedNativePath);
        }
        await resources.releaseArtifacts();
        await retirePluginCache(firstCache);

        const freshCache = resources.cache();
        const persisted = await readIndex(freshCache, state.stateDir);
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
        expectBytes(warm.value.resolve(fixture.filename), fixture.bytes);
        // A native executable resolves a sibling helper from its real installed image path.
        const readChildSdk = (artifact: Artifact) => {
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
          expect(readText(retainedPath)).toBe(readText(installedPath));
        }
        const { loadPluginRegistryHandle } = await import("./loader.js");
        const { resolvePluginMetadataSnapshotAsync } =
          await import("./plugin-metadata-snapshot.js");
        const config = fixtureConfig(fixture.root);
        const successor = capture(freshCache, hosts[1]);
        expectLinkedIo(successor.io);
        expect(successor.value.sourceDigest).toBe(warm.value.sourceDigest);
        await assertDependencyCapture(successor.value);
        expect(readChildSdk(successor.value)).toBe("second");
        expect(readChildSdk(warm.value)).toBe("first");
        const native = receipts[0]!.nativeArtifacts[fixture.filename]!;
        const namespace = receipts[0]!.nativeNamespaces[native.namespace]!;
        expect(fs.realpathSync(path.join(namespace.capturedRoot, "node_modules/openclaw"))).toBe(
          fs.realpathSync(hosts[0]!),
        );

        const loaded = withPluginCache(freshCache, () =>
          loadPluginRegistryHandle({
            config,
            installRecords: persisted.installRecords,
            onlyPluginIds: ["fixture"],
          }),
        );
        const loadedPlugin = expect.objectContaining({
          id: "fixture",
          status: "loaded",
          source: fixture.entry,
        });
        expect(loaded.plugins).toContainEqual(loadedPlugin);
        await resources.releaseArtifacts();
        await retirePluginCache(freshCache);
        const runtimeCache = resources.cache();
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
        expect(runtime.value.plugins).toContainEqual(loadedPlugin);
        expectNoNativeIo(runtime.io);
      } finally {
        observer.restore();
      }
    });
  },
);

it.each([false, true])(
  "admits native source with an unavailable persisted capture (unrelated=%s)",
  async (unrelated) => {
    await withOpenClawTestState({ label: "native-admission-missing-capture" }, async (state) => {
      await using resources = captureResources();
      const fixture = createFixture(state.path("installed"), true);
      const companion = path.join(fixture.root, "README.md");
      fs.writeFileSync(companion, "unchanged native companion");
      const modifiedAt = new Date(1_000);
      fs.utimesSync(companion, modifiedAt, modifiedAt);
      await writePersistedInstalledPluginIndex(fixture.index, { stateDir: state.stateDir });
      const caches = [resources.cache(), resources.cache()];
      const statSync = fs.statSync;
      const lstatSync = fs.lstatSync;
      let fault: MockInstance<typeof fs.statSync> | undefined;
      let rootFault: MockInstance<typeof fs.lstatSync> | undefined;
      try {
        preparePluginNativeAdmissions(fixture.index, caches[0]!);
        const first = resources.capture(caches[0]!, fixture.root);
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
        const replacement = resources.capture(caches[1]!, candidate.root);
        expectBytes(replacement.resolve(candidate.filename), candidate.bytes);
        expect(readText(replacement.resolve(candidateCompanion))).toBe(
          "unchanged native companion",
        );
      } finally {
        rootFault?.mockRestore();
        fault?.mockRestore();
      }
    });
  },
);

it.each(["direct", "transitive"] as const)(
  "keeps %s native companions current across independent cache admissions",
  async (ownership) => {
    await withOpenClawTestState({ label: `native-admission-${ownership}` }, async (state) => {
      await using resources = captureResources();
      const fixture = createFixture(state.path("installed"), true);
      const transitive = ownership === "transitive";
      if (transitive) {
        fs.unlinkSync(fixture.filename);
        const manifestPath = path.join(fixture.root, "package.json");
        const manifest = JSON.parse(readText(manifestPath));
        const dependencies = { "native-a": "1.0.0", "native-b": "1.0.0" };
        fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, dependencies }));
        for (const name of [...Object.keys(dependencies), "common"]) {
          const dependencyRoot = path.join(fixture.root, "node_modules", name);
          writeTree(dependencyRoot, {
            "package.json": {
              name,
              version: "1.0.0",
              ...(name === "common" ? {} : { dependencies: { common: "1.0.0" } }),
            },
            ...(name === "common" ? {} : { "fixture.bin": "native fixture" }),
          });
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
      const caches = [resources.cache(), resources.cache()];
      const capture = (cache: Cache) => {
        // Independent readers can begin from the same index before either publishes its receipt.
        preparePluginNativeAdmissions(fixture.index, cache);
        return resources.capture(cache, fixture.root);
      };

      const first = capture(caches[0]!);
      if (!transitive) {
        expect(readText(first.resolve(companion))).toBe(original);
      }
      const second = capture(caches[1]!);
      if (!transitive) {
        for (const artifact of [first, second]) {
          expect(readText(artifact.resolve(companion))).toBe(original);
          expectBytes(artifact.resolve(fixture.filename), fixture.bytes);
        }
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
      expect(readText(capturedCompanion ?? first.resolve(companion))).toBe(original);
    });
  },
);

it.each([false, true])(
  "captures managed native packages that share a companion dependency (copied=%s)",
  async (copied) => {
    await withOpenClawTestState({ label: "native-shared-companion" }, async (state) => {
      await using resources = captureResources();
      const fixture = createFixture(state.path("installed"), true);
      fs.rmSync(fixture.filename);
      writeTree(fixture.root, {
        "package.json": {
          dependencies: { "a-library": "1.0.0", "b-addon": "1.0.0" },
        },
      });
      if (copied) {
        const manifest =
          '{"id":"fixture","configSchema":{"type":"object"},"providerCatalogEntry":"node_modules/a-library/lib/library.so"}';
        fs.writeFileSync(fixture.index.plugins[0]!.manifestPath, manifest);
        fixture.index.plugins[0]!.manifestHash = createHash("sha256")
          .update(manifest)
          .digest("hex");
      }
      writeTree(path.join(fixture.root, "node_modules"), {
        "a-library/package.json": '{"name":"a-library","version":"1.0.0","main":"lib/helper.cjs"}',
        "a-library/lib/library.so": "native library bytes",
        "a-library/lib/helper.cjs": "module.exports = 'companion';",
        "b-addon/package.json":
          '{"name":"b-addon","main":"lib/addon.node","dependencies":{"a-library":"1.0.0"}}',
        "b-addon/lib/addon.node": "native addon bytes",
        "c-addon/package.json": '{"name":"c-addon","dependencies":{"a-library":"1.0.0"}}',
        "c-addon/lib/addon.node": "another native addon",
      });
      const cache = resources.cache();
      preparePluginNativeAdmissions(fixture.index, cache);
      const library = path.join(fixture.root, "node_modules/a-library/lib/library.so");
      const timestamp = new Date("2020-01-01T00:00:00Z");
      fs.utimesSync(library, timestamp, timestamp);
      const artifact = resources.capture(cache, fixture.root);
      const require = createRequire(path.join(artifact.rootDir, "index.js"));
      expect(require("a-library")).toBe("companion");
      expect(readText(require.resolve("a-library/lib/library.so"))).toBe("native library bytes");
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
      expect(() =>
        resources.capture(cache, path.join(fixture.root, "node_modules/c-addon")),
      ).toThrow("Native plugin companion changed during admission");
    });
  },
);

it("snapshots a mutable native edit once while retained generations keep their previous bytes", async () => {
  await withOpenClawTestState({ label: "native-admission-mutable" }, async (state) => {
    await using resources = captureResources();
    const fixture = createFixture(state.path("source"), false);
    const helper = path.join(fixture.root, "helper.cjs");
    fs.writeFileSync(helper, "module.exports = 'original helper';");
    await writePersistedInstalledPluginIndex(fixture.index, { stateDir: state.stateDir });
    const cache = resources.cache();
    preparePluginNativeAdmissions(fixture.index, cache);
    const observer = observeFileIo(fixture.filename);
    const capture = () => observer.measure(() => resources.capture(cache, fixture.root));
    try {
      const first = capture();
      expectNativeCopy(first.io);
      const readHelper = (artifact: Artifact) =>
        readText(
          path.join(
            path.dirname(fs.realpathSync(artifact.resolve(fixture.filename))),
            "helper.cjs",
          ),
        );
      expect(readHelper(first.value)).toBe("module.exports = 'original helper';");

      const before = fs.statSync(fixture.filename);
      const changedBytes = Buffer.alloc(nativeSize, "B");
      fs.writeFileSync(fixture.filename, changedBytes);
      fs.writeFileSync(helper, "module.exports = 'replacement helper';");
      fs.utimesSync(fixture.filename, before.atime, new Date(before.mtimeMs + 1000));
      expect(fs.statSync(fixture.filename).ino).toBe(before.ino);
      const changed = capture();
      expectNativeCopy(changed.io);
      expect(changed.value.sourceDigest).not.toBe(first.value.sourceDigest);

      const unchanged = capture();
      expectNoNativeIo(unchanged.io);
      expect(unchanged.value.sourceDigest).toBe(changed.value.sourceDigest);
      expectBytes(first.value.resolve(fixture.filename), fixture.bytes);
      expectBytes(changed.value.resolve(fixture.filename), changedBytes);
      expect(readHelper(first.value)).toBe("module.exports = 'original helper';");
      expect(readHelper(changed.value)).toBe("module.exports = 'replacement helper';");

      // A companion edit must replace the namespace even when the native inode is unchanged.
      fs.writeFileSync(helper, "module.exports = 'helper-only edit';");
      const helperChanged = capture();
      expectNativeCopy(helperChanged.io, false);
      expect(readHelper(helperChanged.value)).toBe("module.exports = 'helper-only edit';");
      expect(readHelper(changed.value)).toBe("module.exports = 'replacement helper';");
      expectBytes(helperChanged.value.resolve(fixture.filename), changedBytes);
      expectNoNativeIo(capture().io);
    } finally {
      observer.restore();
    }
  });
});
