import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolvePluginInstallRoots, withPluginInstallRoots } from "./install-root-context.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { acquirePluginRegistryForInspection } from "./loader.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { createFixture } from "./plugin-generation-artifact.admission.test-support.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import {
  preparePluginNativeAdmissions,
  settlePluginNativeAdmissions,
} from "./plugin-native-admission-state.js";
import { linkOpenClawPeerDependencies } from "./plugin-peer-link.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";

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
    fs.mkdirSync(healthy);
    fs.writeFileSync(
      path.join(healthy, "openclaw.plugin.json"),
      JSON.stringify({
        id: "healthy",
        channels: ["healthy-chat"],
        configSchema: { type: "object" },
      }),
    );
    fs.writeFileSync(
      path.join(healthy, "index.js"),
      `export default { id: "healthy", register(api) {
        api.registerChannel({ plugin: {
          id: "healthy-chat",
          meta: { id: "healthy-chat", label: "Healthy", selectionLabel: "Healthy",
            docsPath: "/channels/healthy", blurb: "fixture channel" },
          capabilities: { chatTypes: ["direct"] },
          config: { listAccountIds: () => ["primary", "secondary"],
            resolveAccount: (_, accountId) => ({ accountId }) }
        } });
      } };`,
    );
    const cache = createPluginCache();
    preparePluginNativeAdmissions(fixture.index, cache);
    const link = fs.linkSync;
    const fault = vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
      if (from === fixture.filename) {
        throw Object.assign(new Error("cross-device native capture"), { code: "EXDEV" });
      }
      link(from, to);
    });
    const error = vi.fn();
    try {
      const inspection = await withPluginCache(cache, () =>
        acquirePluginRegistryForInspection({
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
      try {
        const reason = `${path.join(fixture.installRoot, "node_modules", "openclaw")} resolves to ${wrongHost}`;
        expect(inspection.registry.plugins).toContainEqual(
          expect.objectContaining({
            id: "fixture",
            status: "error",
            error: expect.stringContaining(reason),
          }),
        );
        expect(inspection.registry.diagnostics).toContainEqual(
          expect.objectContaining({
            pluginId: "fixture",
            level: "error",
            message: expect.stringContaining(reason),
          }),
        );
        expect(error).toHaveBeenCalledWith(expect.stringContaining("openclaw doctor --fix"));
        expect(inspection.registry.plugins).toContainEqual(
          expect.objectContaining({ id: "healthy", status: "loaded" }),
        );
        const channel = inspection.registry.channels.find(
          ({ plugin }) => plugin.id === "healthy-chat",
        );
        expect(channel?.plugin.config.listAccountIds({})).toEqual(["primary", "secondary"]);
      } finally {
        await inspection.release();
      }
    } finally {
      fault.mockRestore();
      await retirePluginCache(cache);
    }
  });
});

it("validates overlapping hardlinked companion placements once per member, including recovery", async () => {
  await withOpenClawTestState({ label: "native-reference-verdict" }, async (state) => {
    const root = state.path("plugin");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"native-reference-fixture"}');
    fs.writeFileSync(path.join(root, "index.cjs"), "exports.value = 1;");
    fs.writeFileSync(path.join(root, "helper.dat"), "original companion");
    fs.mkdirSync(path.join(root, "nested", "companion-sentinel"), { recursive: true });
    for (let index = 0; index < 33; index++) {
      const directory = index % 2 ? path.join(root, "nested") : root;
      fs.writeFileSync(path.join(directory, `addon-${index}.node`), `native fixture ${index}`);
    }
    const symlink = fs.symlinkSync;
    const denial = vi.spyOn(fs, "symlinkSync").mockImplementation((target, link, type) => {
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
    const cache = createPluginCache();
    const artifacts: ReturnType<typeof capturePluginGenerationArtifact>[] = [];
    let recovery:
      | ReturnType<ReturnType<typeof capturePluginGenerationArtifact>["captureRecoverySource"]>
      | undefined;
    const capture = () => {
      const artifact = withPluginCache(cache, () => capturePluginGenerationArtifact(root));
      artifacts.push(artifact);
      return artifact;
    };
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
      expect(fs.statSync(successor.resolve(path.join(root, "addon-0.node"))).ino).toBe(
        fs.statSync(first.resolve(path.join(root, "addon-0.node"))).ino,
      );
      paths.mockClear();
      successor.linkHost(hosts[1]!);
      expect.soft(walks(successor.rootDir)).toBe(1);
      paths.mockClear();
      recovery = first.captureRecoverySource();
      expect.soft(walks(recovery.rootDir)).toBe(1);
      expect(fs.readFileSync(path.join(recovery.rootDir, "helper.dat"), "utf8")).toBe(
        "original companion",
      );

      fs.writeFileSync(path.join(root, "helper.dat"), "replacement companion");
      const replacement = capture();
      expect(replacement.sourceDigest).not.toBe(first.sourceDigest);
      expect(fs.statSync(replacement.resolve(path.join(root, "addon-0.node"))).ino).not.toBe(
        fs.statSync(first.resolve(path.join(root, "addon-0.node"))).ino,
      );
      expect.soft(walks(replacement.rootDir)).toBe(1);
      expect(fs.readFileSync(path.join(replacement.rootDir, "helper.dat"), "utf8")).toBe(
        "replacement companion",
      );
      expect(fs.readFileSync(path.join(first.rootDir, "helper.dat"), "utf8")).toBe(
        "original companion",
      );
      fs.writeFileSync(path.join(replacement.rootDir, "helper.dat"), "damaged capture");
      expect(() => replacement.linkHost(hosts[0]!)).toThrow(
        "Native plugin companions cannot be preserved",
      );
    } finally {
      paths.mockRestore();
      denial.mockRestore();
      await recovery?.disposeAsync();
      for (const artifact of artifacts) {
        await artifact.disposeAsync();
      }
      await retirePluginCache(cache);
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
        fs.mkdirSync(dependency);
        fs.writeFileSync(
          path.join(dependency, "package.json"),
          JSON.stringify({ name: "native-fixture", version: "1.0.0" }),
        );
        nativeFilename = path.join(dependency, "fixture.bin");
        fs.renameSync(fixture.filename, nativeFilename);
        const manifestPath = path.join(fixture.root, "package.json");
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        fs.writeFileSync(
          manifestPath,
          JSON.stringify({ ...manifest, dependencies: { "native-fixture": "1.0.0" } }),
        );
      }
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
        if (from === nativeFilename) {
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
          const require = createRequire(artifact!.resolve(fixture.entry));
          const native = hoisted
            ? require.resolve("native-fixture/fixture.bin")
            : artifact!.resolve(nativeFilename);
          expect(fs.realpathSync(native)).toBe(nativeFilename);
          expect(fs.readFileSync(native).equals(fixture.bytes)).toBe(true);
          expect(require("./child.cjs")).toBe("first");
          successor = withPluginCache(cache, () => capturePluginGenerationArtifact(fixture.root));
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
          expect(() => successor!.linkHost(selectedHost)).toThrow(
            `does not resolve the selected OpenClaw host ${selectedHost}: ${peer} resolves to ${hosts[hoisted ? 1 : 0]}`,
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
        const secondRoots =
          change === "publication root" ? { ...firstRoots, stateDir: otherState } : firstRoots;
        const scopes = [
          { storage: { stateDir: state.stateDir, placement: "state" as const }, roots: firstRoots },
          {
            storage: {
              stateDir: change === "state root" ? otherState : state.stateDir,
              placement:
                change === "temporary placement" ? ("temporary" as const) : ("state" as const),
            },
            roots: secondRoots,
          },
        ];
        const publicationRoots = [...new Set(scopes.map(({ roots }) => roots.stateDir))];
        const cache = createPluginCache();
        const artifacts: ReturnType<typeof capturePluginGenerationArtifact>[] = [];
        const capturedPaths: string[] = [];
        try {
          for (const stateDir of publicationRoots) {
            await writePersistedInstalledPluginIndex(fixture.index, { stateDir });
          }
          for (const { storage, roots } of scopes) {
            const artifact = withPluginCache(cache, () =>
              withPluginInstallRoots(roots, () =>
                withPluginSourceCaptureStorage(storage, () => {
                  preparePluginNativeAdmissions(fixture.index, cache);
                  return capturePluginGenerationArtifact(fixture.root);
                }),
              ),
            );
            artifacts.push(artifact);
            const captured = fs.realpathSync(artifact.resolve(fixture.filename));
            capturedPaths.push(captured);
            const managed =
              path.join(fs.realpathSync(storage.stateDir), "tmp", "plugin-captures") + path.sep;
            expect(captured.startsWith(managed)).toBe(storage.placement === "state");
            if (storage.placement === "temporary") {
              expect(captured.startsWith(fs.realpathSync(runtimeTemp) + path.sep)).toBe(true);
            }
            expect(fs.readFileSync(captured).equals(fixture.bytes)).toBe(true);
          }
          expect(capturedPaths[0] === capturedPaths[1]).toBe(false);
          await settlePluginNativeAdmissions(cache);
          for (const [index, { roots }] of scopes.entries()) {
            const persisted = await readPersistedInstalledPluginIndex({ stateDir: roots.stateDir });
            const receipt = Object.values(persisted?.plugins[0]?.sourceAdmissions ?? {})[0];
            const expected =
              change === "publication root" ? capturedPaths[index] : capturedPaths[1];
            expect(receipt?.nativeArtifacts[fixture.filename]?.capturedPath).toBe(expected);
          }
          expect(fs.readFileSync(capturedPaths[0]!).equals(fixture.bytes)).toBe(true);
        } finally {
          for (const artifact of artifacts) {
            await artifact.disposeAsync();
          }
          await retirePluginCache(cache);
          for (const stateDir of publicationRoots) {
            await closeOpenClawStateDatabaseByPathAsync(
              resolveOpenClawStateSqlitePath({
                ...state.env,
                OPENCLAW_STATE_DIR: stateDir,
              }),
            );
          }
        }
      });
    });
  },
);
