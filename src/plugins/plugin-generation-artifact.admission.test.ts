import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { hashJson } from "./installed-plugin-index-hash.js";
import { recordInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "./installed-plugin-index-types.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import {
  preparePluginNativeAdmissions,
  settlePluginNativeAdmissions,
} from "./plugin-native-admission-state.js";
import { linkOpenClawPeerDependencies } from "./plugin-peer-link.js";

const nativeSize = 2 * 1024 * 1024;

function createFixture(directory: string, managed: boolean) {
  const installRoot = managed
    ? path.join(directory, "project", "node_modules", "fixture-package")
    : directory;
  const root = managed ? path.join(installRoot, "plugins", "fixture") : directory;
  fs.mkdirSync(root, { recursive: true });
  if (managed) {
    fs.writeFileSync(
      path.join(installRoot, "package.json"),
      JSON.stringify({
        name: "fixture-package",
        version: "1.0.0",
        openclaw: { extensions: ["./plugins/fixture/index.js"] },
      }),
    );
  }
  const manifestPath = path.join(root, "openclaw.plugin.json");
  const manifest = JSON.stringify({ id: "fixture", configSchema: { type: "object" } });
  fs.writeFileSync(manifestPath, manifest);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.js"] },
    }),
  );
  const entry = path.join(root, "index.js");
  fs.writeFileSync(entry, "export default { id: 'fixture', register() {} };\n");
  const filename = path.join(root, managed ? "fixture.bin" : "fixture.so");
  const bytes = Buffer.alloc(nativeSize, "A");
  fs.writeFileSync(filename, bytes);
  const index: InstalledPluginIndex = {
    version: 1,
    hostContractVersion: "2026.9.6",
    compatRegistryVersion: "compat-v1",
    migrationVersion: 1,
    policyHash: "fixture-policy",
    generatedAtMs: 1,
    installRecords: managed
      ? { "fixture-package": { source: "npm", installPath: installRoot } }
      : {},
    plugins: [
      recordInstalledPluginIndexInstallOwner<InstalledPluginIndex["plugins"][number]>(
        {
          pluginId: "fixture",
          manifestPath,
          manifestHash: createHash("sha256").update(manifest).digest("hex"),
          source: entry,
          ...(managed
            ? { installRecordHash: hashJson({ source: "npm", installPath: installRoot }) }
            : {}),
          rootDir: root,
          origin: "global",
          enabled: true,
          startup: { sidecar: false, memory: false, agentHarnesses: [] },
          compat: [],
        },
        managed ? "fixture-package" : undefined,
      ),
    ],
    diagnostics: [],
  };
  return { root, installRoot, entry, filename, bytes, index };
}

function observeNativeIo(filename: string) {
  const original = fs.statSync(filename);
  const readSync = fs.readSync;
  const readFileSync = fs.readFileSync;
  const copyFileSync = fs.copyFileSync;
  const writeSync = fs.writeSync;
  const empty = () => ({ originalBytes: 0, capturedBytes: 0, wholeFileReads: 0, largestBuffer: 0 });
  let current: ReturnType<typeof empty> | undefined;
  let copies = new Set<string>();
  const recordCopy = (stat: fs.Stats) => {
    if (current && stat.size === original.size) {
      copies.add(`${stat.dev}:${stat.ino}`);
    }
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
    vi.spyOn(fs, "copyFileSync").mockImplementation((from, to, mode) => {
      copyFileSync(from, to, mode);
      if (current) {
        recordCopy(fs.statSync(to));
      }
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

it("admits managed native bytes once across captures and a fresh cache reading persisted receipts", async () => {
  await withOpenClawTestState({ label: "native-admission-managed" }, async (state) => {
    const fixture = createFixture(state.path("installed"), true);
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
    try {
      const firstCache = caches[0]!;
      preparePluginNativeAdmissions(fixture.index, firstCache);
      const first = capture(firstCache);
      expect(first.io).toMatchObject({
        originalBytes: nativeSize,
        capturedBytes: 0,
        copies: 0,
        wholeFileReads: 0,
      });
      expect(first.io.largestBuffer).toBeLessThanOrEqual(1024 * 1024);
      for (let registration = 0; registration < 2; registration++) {
        const next = capture(firstCache);
        expectNoNativeIo(next.io);
        expect(next.value.sourceDigest).toBe(first.value.sourceDigest);
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
      expect(warm.value.sourceDigest).toBe(first.value.sourceDigest);
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
        expect(fs.readFileSync(retainedPath, "utf8")).toBe(fs.readFileSync(installedPath, "utf8"));
      }
      const { loadPluginRegistryHandle } = await import("./loader.js");
      const { resolvePluginMetadataSnapshotAsync } = await import("./plugin-metadata-snapshot.js");
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
      for (const artifact of artifacts) {
        await artifact.disposeAsync();
      }
      for (const cache of caches) {
        await retirePluginCache(cache);
      }
    }
  });
});

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
      for (const artifact of artifacts) {
        await artifact.disposeAsync();
      }
      await retirePluginCache(cache);
    }
  });
});

it.each(["npm", "archive"] as const)(
  "uses a source-path fallback only for retained npm trees when linking a %s artifact is unavailable",
  async (source) => {
    await withOpenClawTestState({ label: `native-link-${source}` }, async (state) => {
      const fixture = createFixture(state.path("installed"), true);
      fixture.index.installRecords = {
        "fixture-package": { source, installPath: fixture.installRoot },
      };
      fs.writeFileSync(
        path.join(fixture.root, "child.cjs"),
        "module.exports = require('openclaw/plugin-sdk/identity');",
      );
      const hosts = ["first", "second"].map((identity) => {
        const host = state.path(`fallback-host-${identity}`);
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
      fs.writeFileSync(
        path.join(fixture.installRoot, "package.json"),
        JSON.stringify({
          name: "fixture-package",
          version: "1.0.0",
          peerDependencies: { openclaw: "*" },
        }),
      );
      await linkOpenClawPeerDependencies({
        installedDir: fixture.installRoot,
        peerDependencies: { openclaw: "*" },
        hostRoot: hosts[0],
        logger: {},
      });
      const cache = createPluginCache();
      preparePluginNativeAdmissions(fixture.index, cache);
      const failure = Object.assign(new Error("fixture filesystem does not support hardlinks"), {
        code: "EXDEV",
      });
      const link = fs.linkSync;
      const fault = vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
        if (from === fixture.filename) {
          throw failure;
        }
        link(from, to);
      });
      let artifact: ReturnType<typeof capturePluginGenerationArtifact> | undefined;
      let successor: ReturnType<typeof capturePluginGenerationArtifact> | undefined;
      try {
        const capture = () => {
          artifact = withPluginCache(cache, () => capturePluginGenerationArtifact(fixture.root));
        };
        if (source === "archive") {
          expect(capture).toThrow(failure);
        } else {
          capture();
          artifact!.linkHost(hosts[0]!);
          expect(fs.realpathSync(artifact!.resolve(fixture.filename))).toBe(fixture.filename);
          expect(fs.readFileSync(artifact!.resolve(fixture.filename)).equals(fixture.bytes)).toBe(
            true,
          );
          const native = fs.realpathSync(artifact!.resolve(fixture.filename));
          expect(createRequire(native)(path.join(path.dirname(native), "child.cjs"))).toBe("first");
          successor = withPluginCache(cache, () => capturePluginGenerationArtifact(fixture.root));
          expect(() => successor!.linkHost(hosts[1]!)).toThrow(
            "does not resolve the selected OpenClaw host",
          );
          expect(fs.realpathSync(path.join(fixture.installRoot, "node_modules", "openclaw"))).toBe(
            fs.realpathSync(hosts[0]!),
          );
        }
      } finally {
        fault.mockRestore();
        await successor?.disposeAsync();
        await artifact?.disposeAsync();
        await retirePluginCache(cache);
      }
    });
  },
);
