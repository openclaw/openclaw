import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { hasErrnoCode } from "../infra/errno.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolvePluginInstallRoots, withPluginInstallRoots } from "./install-root-context.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { loadPluginRegistryHandle } from "./loader.js";
import { withPluginCache } from "./plugin-cache.js";
import { createFixture } from "./plugin-generation-artifact.admission.test-support.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import {
  captureResources,
  createSdkHost,
  expectBytes,
  readText,
  writeTree,
  type Artifact,
} from "./plugin-generation-capture.test-support.js";
import {
  preparePluginNativeAdmissions,
  settlePluginNativeAdmissions,
} from "./plugin-native-admission-state.js";
import { linkOpenClawPeerDependencies } from "./plugin-peer-link.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";

afterEach(() => vi.restoreAllMocks());

function failHardlink(filename: string) {
  const failure = Object.assign(new Error("cross-device native capture"), { code: "EXDEV" });
  const link = fs.linkSync;
  vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
    if (from === filename) {
      throw failure;
    }
    link(from, to);
  });
  return failure;
}

function nativeInode(artifact: Artifact, source: string) {
  return fs.statSync(artifact.resolve(path.join(source, "addon-0.node"))).ino;
}

it("records a native host mismatch while preserving unrelated channel accounts", async () => {
  await withOpenClawTestState({ label: "native-host-load-failure" }, async (state) => {
    const fixture = createFixture(state.path("installed"), true);
    const wrongHost = state.path("wrong-host");
    fs.mkdirSync(wrongHost);
    await linkOpenClawPeerDependencies({
      installedDir: fixture.installRoot,
      peerDependencies: { openclaw: "*" },
      hostRoot: wrongHost,
      logger: {},
    });
    const healthy = state.path("healthy");
    writeTree(healthy, {
      "openclaw.plugin.json": {
        id: "healthy",
        channels: ["healthy-chat"],
        configSchema: { type: "object" },
      },
      "index.js": `export default { id: "healthy", register(api) {
        api.registerChannel({ plugin: {
          id: "healthy-chat",
          meta: { id: "healthy-chat", label: "Healthy", selectionLabel: "Healthy",
            docsPath: "/channels/healthy", blurb: "fixture channel" },
          capabilities: { chatTypes: ["direct"] },
          config: { listAccountIds: () => ["primary", "secondary"],
            resolveAccount: (_, accountId) => ({ accountId }) }
        } });
      } };`,
    });
    await using resources = captureResources();
    const cache = resources.cache();
    preparePluginNativeAdmissions(fixture.index, cache);
    failHardlink(fixture.filename);
    const error = vi.fn();
    try {
      const registry = withPluginCache(cache, () =>
        loadPluginRegistryHandle({
          cache: false,
          config: {
            plugins: {
              allow: ["fixture", "healthy"],
              load: { paths: [fixture.root, healthy] },
              slots: { memory: "none" },
            },
          },
          installRecords: fixture.index.installRecords,
          onlyPluginIds: ["fixture", "healthy"],
          logger: { info() {}, warn() {}, error, debug() {} },
        }),
      );
      const reason = `${path.join(fixture.installRoot, "node_modules", "openclaw")} resolves to ${wrongHost}`;
      expect(registry.plugins).toContainEqual(
        expect.objectContaining({
          id: "fixture",
          status: "error",
          error: expect.stringContaining(reason),
        }),
      );
      expect(registry.diagnostics).toContainEqual(
        expect.objectContaining({
          pluginId: "fixture",
          level: "error",
          message: expect.stringContaining(reason),
        }),
      );
      expect(error).toHaveBeenCalledWith(expect.stringContaining("openclaw doctor --fix"));
      expect(registry.plugins).toContainEqual(
        expect.objectContaining({ id: "healthy", status: "loaded" }),
      );
      const channel = registry.channels.find(({ plugin }) => plugin.id === "healthy-chat");
      expect(channel?.plugin.config.listAccountIds({})).toEqual(["primary", "secondary"]);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

it("validates overlapping hardlinked companion placements once per member, including recovery", async () => {
  await withOpenClawTestState({ label: "native-reference-verdict" }, async (state) => {
    const root = state.path("plugin");
    writeTree(root, {
      "package.json": '{"name":"native-reference-fixture"}',
      "index.cjs": "exports.value = 1;",
      "helper.dat": "original companion",
    });
    fs.mkdirSync(path.join(root, "nested", "companion-sentinel"), { recursive: true });
    for (let index = 0; index < 33; index++) {
      const directory = index % 2 ? path.join(root, "nested") : root;
      fs.writeFileSync(path.join(directory, `addon-${index}.node`), `native fixture ${index}`);
    }
    const symlink = fs.symlinkSync;
    vi.spyOn(fs, "symlinkSync").mockImplementation((target, link, type) => {
      if (type === "file") {
        throw Object.assign(new Error("fixture file symlinks unavailable"), { code: "EPERM" });
      }
      symlink(target, link, type);
    });
    const paths = vi.spyOn(fs, "realpathSync");
    const walks = (directory: string) =>
      paths.mock.calls.filter(
        ([filename]) => filename === path.join(directory, "nested", "companion-sentinel"),
      ).length;
    await using resources = captureResources();
    const cache = resources.cache();
    const capture = () => resources.capture(cache, root);
    let recovery: ReturnType<Artifact["captureRecoverySource"]> | undefined;
    try {
      const first = capture();
      expect.soft(walks(first.rootDir)).toBe(1);
      paths.mockClear();
      for (let index = 0; index < 8; index++) {
        first.prepareDependency(first.resolve(path.join(root, "index.cjs")), "node:fs");
      }
      expect.soft(walks(first.rootDir)).toBe(0);

      const hosts = [state.path("host-first"), state.path("host-second")];
      for (const host of hosts) {
        fs.mkdirSync(host);
      }
      paths.mockClear();
      first.linkHost(hosts[0]!);
      expect.soft(walks(first.rootDir)).toBe(1);
      const successor = capture();
      expect.soft(walks(successor.rootDir)).toBe(1);
      expect(nativeInode(successor, root)).toBe(nativeInode(first, root));
      paths.mockClear();
      successor.linkHost(hosts[1]!);
      expect.soft(walks(successor.rootDir)).toBe(1);
      paths.mockClear();
      recovery = first.captureRecoverySource();
      expect.soft(walks(recovery.rootDir)).toBe(1);
      expect(readText(path.join(recovery.rootDir, "helper.dat"))).toBe("original companion");

      writeTree(root, { "helper.dat": "replacement companion" });
      const replacement = capture();
      expect(replacement.sourceDigest).not.toBe(first.sourceDigest);
      expect(nativeInode(replacement, root)).not.toBe(nativeInode(first, root));
      expect.soft(walks(replacement.rootDir)).toBe(1);
      expect(readText(path.join(replacement.rootDir, "helper.dat"))).toBe("replacement companion");
      expect(readText(path.join(first.rootDir, "helper.dat"))).toBe("original companion");
      writeTree(replacement.rootDir, { "helper.dat": "damaged capture" });
      expect(() => replacement.linkHost(hosts[0]!)).toThrow(
        "Native plugin companions cannot be preserved",
      );
    } finally {
      vi.restoreAllMocks();
      await recovery?.disposeAsync();
    }
  });
});

it.each([
  { source: "npm", hoisted: false, aliased: false },
  { source: "archive", hoisted: false, aliased: false },
  { source: "npm", hoisted: true, aliased: true },
] as const)(
  "handles cross-device $source native artifacts (hoisted: $hoisted, aliased: $aliased)",
  async ({ source, hoisted, aliased }) => {
    await withOpenClawTestState({ label: `native-link-${source}` }, async (state) => {
      const fixture = createFixture(state.path("installed"), true);
      fixture.index.installRecords = {
        "fixture-package": { source, installPath: fixture.installRoot },
      };
      if (aliased) {
        const alias = state.path("npm-alias");
        fs.symlinkSync(state.path("installed"), alias, "junction");
        fixture.index.installRecords["fixture-package"]!.installPath = path.join(
          alias,
          path.relative(state.path("installed"), fixture.installRoot),
        );
      }
      let nativeFilename = fixture.filename;
      if (hoisted) {
        const dependency = path.join(path.dirname(fixture.installRoot), "native-fixture");
        writeTree(dependency, { "package.json": { name: "native-fixture", version: "1.0.0" } });
        nativeFilename = path.join(dependency, "fixture.bin");
        fs.renameSync(fixture.filename, nativeFilename);
        const manifestPath = path.join(fixture.root, "package.json");
        const manifest = JSON.parse(readText(manifestPath));
        writeTree(fixture.root, {
          "package.json": { ...manifest, dependencies: { "native-fixture": "1.0.0" } },
        });
      }
      writeTree(fixture.root, {
        "child.cjs": "module.exports = require('openclaw/plugin-sdk/identity');",
      });
      const hosts = ["first", "second"].map((id) =>
        createSdkHost(state.path(`fallback-host-${id}`), id),
      );
      writeTree(fixture.installRoot, {
        "package.json": {
          name: "fixture-package",
          version: "1.0.0",
          peerDependencies: { openclaw: "*" },
        },
      });
      await linkOpenClawPeerDependencies({
        installedDir: fixture.installRoot,
        peerDependencies: { openclaw: "*" },
        hostRoot: hosts[0],
        logger: {},
      });
      await using resources = captureResources();
      const cache = resources.cache();
      preparePluginNativeAdmissions(fixture.index, cache);
      const failure = failHardlink(nativeFilename);
      const capture = () => resources.capture(cache, fixture.root);
      try {
        if (source === "archive") {
          expect(capture).toThrow(failure);
        } else {
          const artifact = capture();
          artifact.linkHost(hosts[0]!);
          const require = createRequire(artifact.resolve(fixture.entry));
          const native = hoisted
            ? require.resolve("native-fixture/fixture.bin")
            : artifact.resolve(nativeFilename);
          expect(fs.realpathSync(native)).toBe(nativeFilename);
          expectBytes(native, fixture.bytes);
          expect(require("./child.cjs")).toBe("first");
          const successor = capture();
          const peer = path.join(
            hoisted ? path.dirname(nativeFilename) : fixture.installRoot,
            "node_modules",
            "openclaw",
          );
          if (hoisted) {
            fs.mkdirSync(path.dirname(peer));
            fs.symlinkSync(hosts[1]!, peer, "junction");
          }
          const selectedHost = hosts[hoisted ? 0 : 1]!;
          expect(() => successor.linkHost(selectedHost)).toThrow(
            `does not resolve the selected OpenClaw host ${selectedHost}: ${peer} resolves to ${hosts[hoisted ? 1 : 0]}`,
          );
          expect(fs.realpathSync(path.join(fixture.installRoot, "node_modules", "openclaw"))).toBe(
            fs.realpathSync(hosts[0]!),
          );
        }
      } finally {
        vi.restoreAllMocks();
      }
    });
  },
);

it("captures native companions into state on another filesystem", async ({ skip }) => {
  await withOpenClawTestState({ label: "native-cross-device" }, async (state) => {
    const fixture = createFixture(state.path("image"), true);
    let captureState: string | undefined;
    for (const parent of ["/dev/shm", "/tmp", "/var/tmp"]) {
      try {
        if (fs.statSync(parent).dev !== fs.statSync(fixture.root).dev) {
          captureState = fs.mkdtempSync(path.join(parent, "openclaw-native-state-"));
          break;
        }
      } catch (error) {
        if (
          !["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EROFS"].some((code) =>
            hasErrnoCode(error, code),
          )
        ) {
          throw error;
        }
      }
    }
    if (!captureState) {
      skip("requires a writable filesystem distinct from the plugin source");
      return;
    }
    try {
      fixture.index.installRecords = {
        "fixture-package": { source: "archive", installPath: fixture.installRoot },
      };
      const companion = path.join(fixture.root, "README.md");
      fs.writeFileSync(companion, "native companion sentinel");
      await using resources = captureResources();
      const cache = resources.cache();
      const artifact = resources.keep(
        withPluginCache(cache, () =>
          withPluginSourceCaptureStorage({ stateDir: captureState, placement: "state" }, () => {
            preparePluginNativeAdmissions(fixture.index, cache);
            return capturePluginGenerationArtifact(fixture.root);
          }),
        ),
      );
      expect(fs.statSync(fixture.root).dev).not.toBe(fs.statSync(captureState).dev);
      expectBytes(artifact.resolve(fixture.filename), fixture.bytes);
      const captured = artifact.resolve(companion);
      expect(readText(captured)).toBe("native companion sentinel");
      expect(fs.statSync(captured).dev).toBe(fs.statSync(captureState).dev);
      expect(fs.statSync(companion).nlink).toBe(1);
      expect(fs.realpathSync(captured)).not.toBe(companion);
    } finally {
      fs.rmSync(captureState, { recursive: true, force: true });
    }
  });
});

it("keeps temporary native inspections from hardlinking rehearsal companions", async () => {
  await withOpenClawTestState({ label: "native-rehearsal-companions" }, async (state) => {
    const fixture = createFixture(state.path("installed"), true);
    const companion = path.join(fixture.root, "versions.json");
    fs.writeFileSync(companion, '{"vips":"fixture"}');
    const before = fs.statSync(companion, { bigint: true });
    await using resources = captureResources();
    const cache = resources.cache();
    const artifact = resources.keep(
      withPluginCache(cache, () =>
        withPluginSourceCaptureStorage({ stateDir: state.stateDir, placement: "temporary" }, () => {
          preparePluginNativeAdmissions(fixture.index, cache);
          return capturePluginGenerationArtifact(fixture.root);
        }),
      ),
    );
    const captured = fs.realpathSync(artifact.resolve(companion));
    expect(readText(captured)).toBe('{"vips":"fixture"}');
    expect(fs.statSync(companion, { bigint: true })).toMatchObject({
      dev: before.dev,
      ino: before.ino,
      nlink: 1n,
      ctimeNs: before.ctimeNs,
    });
    expect(fs.statSync(captured, { bigint: true }).ino).not.toBe(before.ino);
    fs.writeFileSync(captured, "private inspection change");
    expect(readText(companion)).toBe('{"vips":"fixture"}');
  });
});

it.each(["state root", "temporary placement", "publication root"] as const)(
  "keeps native admission in its selected %s within one cache",
  async (change) => {
    await withOpenClawTestState({ label: "native-admission-storage" }, async (state) => {
      const runtimeTemp = state.path("capture-temp");
      fs.mkdirSync(runtimeTemp);
      await withEnvAsync({ TMPDIR: runtimeTemp, TMP: runtimeTemp, TEMP: runtimeTemp }, async () => {
        const fixture = createFixture(state.path("installed"), false);
        const otherState = state.path("other-state");
        const firstRoots = resolvePluginInstallRoots(state.env);
        const scopes = [false, true].map((second) => ({
          storage: {
            stateDir: second && change === "state root" ? otherState : state.stateDir,
            placement:
              second && change === "temporary placement"
                ? ("temporary" as const)
                : ("state" as const),
          },
          roots:
            second && change === "publication root"
              ? { ...firstRoots, stateDir: otherState }
              : firstRoots,
        }));
        const publicationRoots = [...new Set(scopes.map(({ roots }) => roots.stateDir))];
        const capturedPaths: string[] = [];
        try {
          await using resources = captureResources();
          const cache = resources.cache();
          for (const stateDir of publicationRoots) {
            await writePersistedInstalledPluginIndex(fixture.index, { stateDir });
          }
          for (const { storage, roots } of scopes) {
            const artifact = resources.keep(
              withPluginCache(cache, () =>
                withPluginInstallRoots(roots, () =>
                  withPluginSourceCaptureStorage(storage, () => {
                    preparePluginNativeAdmissions(fixture.index, cache);
                    return capturePluginGenerationArtifact(fixture.root);
                  }),
                ),
              ),
            );
            const captured = fs.realpathSync(artifact.resolve(fixture.filename));
            capturedPaths.push(captured);
            const managed =
              path.join(fs.realpathSync(storage.stateDir), "tmp", "plugin-captures") + path.sep;
            expect(captured.startsWith(managed)).toBe(storage.placement === "state");
            if (storage.placement === "temporary") {
              expect(captured.startsWith(fs.realpathSync(runtimeTemp) + path.sep)).toBe(true);
            }
            expectBytes(captured, fixture.bytes);
          }
          expect(capturedPaths[0]).not.toBe(capturedPaths[1]);
          await settlePluginNativeAdmissions(cache);
          for (const [index, { roots }] of scopes.entries()) {
            const persisted = await readPersistedInstalledPluginIndex({ stateDir: roots.stateDir });
            const receipt = Object.values(persisted?.plugins[0]?.sourceAdmissions ?? {})[0];
            const expected =
              change === "publication root" ? capturedPaths[index] : capturedPaths[1];
            expect(receipt?.nativeArtifacts[fixture.filename]?.capturedPath).toBe(expected);
          }
          expectBytes(capturedPaths[0]!, fixture.bytes);
        } finally {
          for (const stateDir of publicationRoots) {
            await closeOpenClawStateDatabaseByPathAsync(
              resolveOpenClawStateSqlitePath({ ...state.env, OPENCLAW_STATE_DIR: stateDir }),
            );
          }
        }
      });
    });
  },
);
