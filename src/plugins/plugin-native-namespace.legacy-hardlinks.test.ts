import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { createFixture } from "./plugin-generation-artifact.admission.test-support.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import {
  preparePluginNativeAdmissions,
  settlePluginNativeAdmissions,
} from "./plugin-native-admission-state.js";
import {
  assertPluginNativeNamespaceHost,
  pluginNativeNamespacesOwnSourceHardlinks,
  pluginNativeNamespaceUntrustedHardlinks,
  trackPluginNativeNamespaceAdmissionLink,
} from "./plugin-native-namespace.js";
import type { PluginNativeNamespaceFact } from "./plugin-source-admission.types.js";
import { pluginSourceStatIdentity } from "./plugin-source-file.js";

const captureBudget = {
  maxEntries: 10_000,
  maxFiles: 10_000,
  maxBytes: 32 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
};

it("fails closed when the native source directory cannot be resolved", async () => {
  await withOpenClawTestState({ label: "native-source-realpath-denied" }, async (state) => {
    const sourceDirectory = state.path("source");
    const pluginRoot = state.path("plugin");
    fs.mkdirSync(sourceDirectory, { recursive: true });
    fs.mkdirSync(pluginRoot, { recursive: true });
    const fact: PluginNativeNamespaceFact = {
      sourceDirectory,
      capturedRoot: state.path("capture"),
      managed: true,
      members: {},
    };
    const realpath = fs.realpathSync.bind(fs);
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const failure = vi.spyOn(fs, "realpathSync").mockImplementation(((filename: fs.PathLike) => {
      if (filename === sourceDirectory) {
        throw denied;
      }
      return realpath(filename);
    }) as unknown as typeof fs.realpathSync);
    try {
      expect(() => assertPluginNativeNamespaceHost(fact, pluginRoot, pluginRoot)).toThrow(denied);
    } finally {
      failure.mockRestore();
    }
  });
});

it("keeps strict and budgeted native captures private while charging reuse once", async () => {
  await withOpenClawTestState({ label: "managed-native-reused-budget" }, async (state) => {
    const fixture = createFixture(state.path("installed"), true);
    const cache = createPluginCache();
    preparePluginNativeAdmissions(fixture.index, cache);
    const first = withPluginCache(cache, () =>
      capturePluginGenerationArtifact(
        fixture.root,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { copyNativeFiles: true },
      ),
    );
    let second: ReturnType<typeof capturePluginGenerationArtifact> | undefined;
    try {
      const firstCaptured = first.resolve(fixture.filename, true);
      expect(fs.statSync(firstCaptured).ino).not.toBe(fs.statSync(fixture.filename).ino);
      expect(fs.statSync(firstCaptured, { bigint: true }).nlink).toBe(1n);
      second = withPluginCache(cache, () =>
        capturePluginGenerationArtifact(
          fixture.root,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { ...captureBudget, maxBytes: 6 * 1024 * 1024 },
        ),
      );
      const captured = second.resolve(fixture.filename);
      expect(fs.statSync(captured).ino).not.toBe(fs.statSync(fixture.filename).ino);
      expect(fs.statSync(captured, { bigint: true }).nlink).toBe(1n);
    } finally {
      await second?.disposeAsync();
      await first.disposeAsync();
      await retirePluginCache(cache);
    }
  });
});

it("replaces hardlinked recovery namespaces for strict captures", async () => {
  await withOpenClawTestState({ label: "managed-native-strict-recovery" }, async (state) => {
    const fixture = createFixture(state.path("installed"), true);
    const cache = createPluginCache();
    preparePluginNativeAdmissions(fixture.index, cache);
    const first = withPluginCache(cache, () => capturePluginGenerationArtifact(fixture.root));
    const recovery = first.captureRecoverySource();
    let strict: ReturnType<typeof capturePluginGenerationArtifact> | undefined;
    try {
      strict = withPluginCache(cache, () =>
        capturePluginGenerationArtifact(
          fixture.root,
          undefined,
          undefined,
          undefined,
          recovery.native,
          undefined,
          { copyNativeFiles: true },
        ),
      );
      const captured = strict.resolve(fixture.filename, true);
      expect(fs.statSync(captured).ino).not.toBe(fs.statSync(fixture.filename).ino);
      expect(fs.statSync(captured, { bigint: true }).nlink).toBe(1n);
    } finally {
      await strict?.disposeAsync();
      await recovery.disposeAsync();
      await first.disposeAsync();
      await retirePluginCache(cache);
    }
  });
});

it.each([false, true])(
  "captures managed native file aliases without treating admission ctime as mutation (hardlink fallback=%s)",
  async (hardlinkFallback) => {
    await withOpenClawTestState({ label: "managed-native-file-alias" }, async (state) => {
      const fixture = createFixture(state.path("installed"), true);
      fs.symlinkSync(path.basename(fixture.filename), path.join(fixture.root, "alias.bin"), "file");
      const symlink = fs.symlinkSync;
      const denial = hardlinkFallback
        ? vi.spyOn(fs, "symlinkSync").mockImplementation((target, link, type) => {
            if (type === "file") {
              throw Object.assign(new Error("fixture file symlinks unavailable"), {
                code: "EPERM",
              });
            }
            symlink(target, link, type);
          })
        : undefined;
      const cache = createPluginCache();
      preparePluginNativeAdmissions(fixture.index, cache);
      let artifact: ReturnType<typeof capturePluginGenerationArtifact> | undefined;
      try {
        artifact = withPluginCache(cache, () => capturePluginGenerationArtifact(fixture.root));
        expect(() => artifact!.assertNoHardlinks()).not.toThrow();
        expect(fs.readFileSync(artifact.resolve(path.join(fixture.root, "alias.bin")))).toEqual(
          fixture.bytes,
        );
      } finally {
        denial?.mockRestore();
        await artifact?.disposeAsync();
        await retirePluginCache(cache);
      }
    });
  },
);

it("rechecks native hardlinks before enforcing the strict capture policy", async () => {
  await withOpenClawTestState({ label: "managed-native-late-hardlink" }, async (state) => {
    const fixture = createFixture(state.path("installed"), true);
    const alias = path.join(fixture.root, "alias.bin");
    fs.symlinkSync(path.basename(fixture.filename), alias, "file");
    const cache = createPluginCache();
    preparePluginNativeAdmissions(fixture.index, cache);
    const artifact = withPluginCache(cache, () =>
      capturePluginGenerationArtifact(
        fixture.root,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        captureBudget,
      ),
    );
    try {
      fs.linkSync(fixture.filename, state.path("late-native-link.bin"));
      expect(() => artifact.assertNoHardlinks()).toThrow("hardlinked");
      expect(() => artifact.resolve(fixture.filename, true)).toThrow("hardlinked");
      expect(() => artifact.resolve(alias, true)).toThrow("hardlinked");
    } finally {
      await artifact.disposeAsync();
      await retirePluginCache(cache);
    }
  });
});

it("rejects a source pathname replaced during native link inventory validation", async () => {
  await withOpenClawTestState({ label: "native-link-inventory-substitution" }, async (state) => {
    const source = state.path("source.node");
    const external = state.path("external.node");
    const capturedRoot = state.path("capture");
    const captured = path.join(capturedRoot, "content", "addon.node");
    fs.mkdirSync(path.dirname(captured), { recursive: true });
    fs.writeFileSync(source, "native fixture");
    fs.linkSync(source, captured);
    const sourceStat = fs.lstatSync(source, { bigint: true });
    const capturedStat = fs.lstatSync(captured, { bigint: true });
    const namespace: PluginNativeNamespaceFact = {
      sourceDirectory: path.dirname(source),
      capturedRoot,
      managed: true,
      members: {
        "addon.node": {
          source,
          sourceIdentity: pluginSourceStatIdentity(sourceStat),
          capturedIdentity: pluginSourceStatIdentity(capturedStat),
          boundaryChecked: true,
          admissionHardlinks: [source, captured],
          contentHash: "0".repeat(64),
          sizeBytes: Number(sourceStat.size),
        },
      },
    };
    const lstat = fs.lstatSync.bind(fs);
    let replaced = false;
    const race = vi.spyOn(fs, "lstatSync").mockImplementation(((filename, options) => {
      const stat = lstat(filename, options);
      if (!replaced && filename === captured) {
        fs.renameSync(source, external);
        fs.symlinkSync(captured, source, "file");
        replaced = true;
      }
      return stat;
    }) as typeof fs.lstatSync);
    try {
      expect(pluginNativeNamespaceUntrustedHardlinks([namespace])).toContain(source);
    } finally {
      race.mockRestore();
    }
  });
});

it("recognizes admission-owned hardlinks split across namespace receipts", async () => {
  await withOpenClawTestState({ label: "native-split-admission-links" }, async (state) => {
    const source = state.path("source.node");
    const captures = [state.path("first.node"), state.path("second.node")];
    fs.writeFileSync(source, "native fixture");
    for (const capture of captures) {
      fs.linkSync(source, capture);
    }
    const stat = fs.statSync(source, { bigint: true });
    const namespace = (capture: string): PluginNativeNamespaceFact => ({
      sourceDirectory: path.dirname(source),
      capturedRoot: path.dirname(capture),
      managed: true,
      members: {
        [path.basename(capture)]: {
          source,
          sourceIdentity: pluginSourceStatIdentity(stat),
          capturedIdentity: pluginSourceStatIdentity(stat),
          boundaryChecked: true,
          admissionHardlinks: [source, capture],
          contentHash: "0".repeat(64),
          sizeBytes: Number(stat.size),
        },
      },
    });
    expect(pluginNativeNamespacesOwnSourceHardlinks(captures.map(namespace), source, stat)).toBe(
      true,
    );
  });
});

it("propagates recovery links across members after an original source is removed", async () => {
  await withOpenClawTestState({ label: "native-recovery-link-propagation" }, async (state) => {
    const retained = state.path("retained.node");
    const peer = state.path("peer.node");
    const target = state.path("target.node");
    const external = state.path("external.node");
    fs.writeFileSync(retained, "native fixture");
    fs.linkSync(retained, peer);
    const stat = fs.statSync(retained, { bigint: true });
    const member = (source: string): PluginNativeNamespaceFact["members"][string] => ({
      source,
      sourceIdentity: pluginSourceStatIdentity(stat),
      capturedIdentity: pluginSourceStatIdentity(stat),
      boundaryChecked: true,
      admissionHardlinks: [retained, peer],
      contentHash: "0".repeat(64),
      sizeBytes: Number(stat.size),
    });
    const removedMember = member(state.path("removed.node"));
    const retainedMember = member(retained);
    const namespace: PluginNativeNamespaceFact = {
      sourceDirectory: path.dirname(retained),
      capturedRoot: state.path("capture"),
      managed: true,
      members: { removed: removedMember, retained: retainedMember },
    };

    const recordLink = trackPluginNativeNamespaceAdmissionLink(
      namespace,
      removedMember,
      retained,
      target,
    );
    fs.linkSync(retained, target);
    recordLink();

    expect(removedMember.admissionHardlinks).toEqual([retained, peer, target]);
    expect(retainedMember.admissionHardlinks).toEqual([retained, peer, target]);
    fs.linkSync(retained, external);
    expect(
      pluginNativeNamespaceUntrustedHardlinks([
        { ...namespace, members: { retained: retainedMember } },
      ]),
    ).toContain(retained);
  });
});

it.each([false, true])(
  "upgrades legacy managed native link receipts while rejecting external links (external=%s)",
  async (external) => {
    await withOpenClawTestState({ label: "managed-native-legacy-hardlinks" }, async (state) => {
      const fixture = createFixture(state.path("installed"), true);
      await writePersistedInstalledPluginIndex(fixture.index, { stateDir: state.stateDir });
      const firstCache = createPluginCache();
      preparePluginNativeAdmissions(fixture.index, firstCache);
      const first = withPluginCache(firstCache, () =>
        capturePluginGenerationArtifact(fixture.root),
      );
      await settlePluginNativeAdmissions(firstCache);
      await first.disposeAsync();
      await retirePluginCache(firstCache);

      const persisted = await readPersistedInstalledPluginIndex({ stateDir: state.stateDir });
      expect(persisted).not.toBeNull();
      const receipt = Object.values(persisted!.plugins[0]!.sourceAdmissions ?? {})[0]!;
      for (const namespace of Object.values(receipt.nativeNamespaces)) {
        for (const member of Object.values(namespace.members)) {
          delete member.admissionHardlinks;
        }
      }
      if (external) {
        fs.linkSync(fixture.filename, state.path("external-native-link.node"));
      }

      const cache = createPluginCache();
      preparePluginNativeAdmissions(persisted!, cache);
      const artifact = withPluginCache(cache, () =>
        capturePluginGenerationArtifact(
          fixture.root,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          captureBudget,
        ),
      );
      try {
        if (external) {
          expect(() => artifact.assertNoHardlinks()).toThrow("hardlinked");
        } else {
          expect(() => artifact.assertNoHardlinks()).not.toThrow();
        }
      } finally {
        await artifact.disposeAsync();
        await retirePluginCache(cache);
      }
    });
  },
);
