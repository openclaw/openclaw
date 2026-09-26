import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveStateDir } from "../config/state-dir.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { PluginInstance } from "./plugin-instance.js";
import { createPluginModuleGenerationTestHarness } from "./plugin-module-generation.test-support.js";

const { fixture, host } = createPluginModuleGenerationTestHarness();

describe("plugin generation sibling assets", () => {
  it.each([false, true])(
    "handles a native alias companion directory (file symlinks denied: %s)",
    (denyFileSymlinks) => {
      const root = fixture({
        "package.json": '{"name":"native-alias-fixture"}',
        "platform/addon.node": "native fixture bytes",
        "platform/helper.dat": "original real-directory companion",
        "entry.cjs": `
        const fs = require('node:fs');
        const path = require('node:path');
        exports.read = () => {
          const native = fs.realpathSync(path.join(__dirname, 'bin', 'addon.node'));
          return fs.readFileSync(path.join(path.dirname(native), 'helper.dat'), 'utf8');
        };`,
      });
      fs.mkdirSync(path.join(root, "bin"));
      fs.symlinkSync("../platform/addon.node", path.join(root, "bin", "addon.node"), "file");
      type NativeCompanion = { read(): string };
      const entry = path.join(root, "entry.cjs");
      expect((createRequire(entry)(entry) as NativeCompanion).read()).toBe(
        "original real-directory companion",
      );
      if (denyFileSymlinks) {
        const symlink = fs.symlinkSync;
        const denial = vi.spyOn(fs, "symlinkSync").mockImplementation((target, link, type) => {
          if (type === "file") {
            throw Object.assign(new Error("fixture file symlink privilege is unavailable"), {
              code: "EPERM",
            });
          }
          symlink(target, link, type);
        });
        try {
          expect(() => host(root, true).load("entry.cjs")).toThrow(
            "Native plugin companions cannot be preserved without file symlinks. Enable file symlink support for this filesystem, then reload the plugin.",
          );
        } finally {
          denial.mockRestore();
        }
        return;
      }
      const captured = host(root, true).load("entry.cjs") as NativeCompanion;
      expect(captured.read()).toBe("original real-directory companion");
      fs.writeFileSync(path.join(root, "platform", "helper.dat"), "replacement companion");
      expect(captured.read()).toBe("original real-directory companion");
    },
  );

  it("keeps computed source siblings beside the admitted native realpath", async () => {
    await withOpenClawTestState({ label: "native-lazy-companion" }, async (state) => {
      const root = state.path("plugin");
      fs.mkdirSync(root);
      fs.writeFileSync(path.join(root, "package.json"), '{"name":"native-lazy-fixture"}');
      fs.writeFileSync(path.join(root, "tool.bin"), "native fixture bytes");
      const helper = 'exports.value = "late";';
      fs.writeFileSync(path.join(root, "helper.cjs"), helper);
      const entry = path.join(root, "index.cjs");
      fs.writeFileSync(
        entry,
        `const fs = require('node:fs');
         const path = require('node:path');
         exports.native = fs.realpathSync(path.join(__dirname, 'tool.bin'));
         exports.read = name => require(name).value;`,
      );
      const cache = createPluginCache();
      const instance = new PluginInstance("native-lazy-fixture");
      try {
        withPluginCache(cache, () =>
          bindPluginInstanceModuleLoader({
            instance,
            origin: "config",
            source: entry,
            rootDir: root,
            standalone: true,
          }),
        );
        const api = instance.loadModule(entry) as { native: string; read(name: string): string };
        const sibling = path.join(path.dirname(api.native), "helper.cjs");
        // Native execution can request any sibling before JavaScript imports that companion.
        expect(fs.existsSync(sibling)).toBe(true);
        fs.writeFileSync(
          path.join(root, "helper.cjs"),
          'exports.value = "edited after admission";',
        );
        expect(api.read("./helper.cjs")).toBe("late");
        expect(fs.existsSync(sibling)).toBe(true);
        expect(fs.readFileSync(sibling, "utf8")).toBe(helper);
      } finally {
        await instance.dispose();
        await retirePluginCache(cache);
      }
    });
  });

  it("keeps an external optional sibling inside the captured generation", () => {
    const external = fixture({
      "package.json": '{"name":"native-platform","version":"1.0.0"}',
      "vec0.so": "external fixture bytes",
    });
    const root = fixture({
      "package.json": '{"dependencies":{"dep":"1.0.0"}}',
      "entry.cjs": "module.exports = require('dep');",
      "node_modules/dep/package.json":
        '{"main":"index.cjs","optionalDependencies":{"native-platform":"1.0.0"}}',
      "node_modules/dep/index.cjs": "module.exports = {};",
    });
    fs.symlinkSync(external, path.join(root, "node_modules/native-platform"), "junction");
    const artifact = capturePluginGenerationArtifact(root);
    try {
      const inspectLinks = (directory: string) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const filename = path.join(directory, entry.name);
          if (entry.isSymbolicLink()) {
            const boundary =
              entry.name === "vec0.so"
                ? path.join(resolveStateDir(), "tmp", "plugin-captures")
                : artifact.boundaryRoot;
            const relative = path.relative(boundary, fs.realpathSync(filename));
            expect(relative).not.toBe("..");
            expect(relative.startsWith(`..${path.sep}`)).toBe(false);
            expect(path.isAbsolute(relative)).toBe(false);
          } else if (entry.isDirectory()) {
            inspectLinks(filename);
          }
        }
      };
      inspectLinks(artifact.boundaryRoot);
      const capturedExternal = artifact.sourceAliases[fs.realpathSync(external)];
      fs.writeFileSync(path.join(external, "vec0.so"), "changed external source");
      expect(fs.readFileSync(path.join(capturedExternal!, "vec0.so"), "utf8")).toBe(
        "external fixture bytes",
      );
    } finally {
      artifact.dispose();
    }
  });

  it.each(["hoisted", "nested", "linked"])(
    "preserves optional native siblings in a %s install across generations",
    async (layout) => {
      const modules =
        layout === "nested"
          ? "node_modules/parent/node_modules"
          : layout === "linked"
            ? "node_modules/.pnpm/dep@1/node_modules"
            : "node_modules";
      const platform =
        layout === "linked"
          ? "node_modules/.pnpm/native-platform@1/node_modules/native-platform"
          : `${modules}/native-platform`;
      const peer = "node_modules/.pnpm/native-peer@1/node_modules/native-peer";
      const root = fixture({
        "package.json": JSON.stringify({
          dependencies: { [layout === "nested" ? "parent" : "dep"]: "1.0.0" },
        }),
        "entry.cjs": `module.exports = require('${layout === "nested" ? "parent" : "dep"}');`,
        ...(layout === "nested"
          ? {
              "node_modules/parent/package.json":
                '{"main":"index.cjs","dependencies":{"dep":"1.0.0"}}',
              "node_modules/parent/index.cjs": "module.exports = require('dep');",
            }
          : {}),
        [`${modules}/dep/package.json`]: JSON.stringify({
          main: "index.cjs",
          optionalDependencies: { "native-platform": "1.0.0", "absent-platform": "1.0.0" },
        }),
        [`${modules}/dep/index.cjs`]: `
          const fs = require('node:fs');
          const path = require('node:path');
          const { createRequire } = require('node:module');
          exports.read = () => {
            const native = fs.realpathSync(require.resolve('native-platform/vec0.so'));
            return [
              fs.readFileSync(path.join(__dirname, '../native-platform/vec0.so'), 'utf8'),
              fs.readFileSync(native, 'utf8'),
              ${
                layout === "linked"
                  ? `require('native-platform/helper.cjs').read(),
                     createRequire(native)(path.join(path.dirname(native), 'helper.cjs')).read(),`
                  : ""
              }
            ];
          };`,
        [`${platform}/package.json`]: JSON.stringify({
          name: "native-platform",
          version: "1.0.0",
          ...(layout === "linked" ? { peerDependencies: { "native-peer": "1.0.0" } } : {}),
        }),
        [`${platform}/vec0.so`]: "before",
        ...(layout === "linked"
          ? {
              [`${platform}/helper.cjs`]: "exports.read = () => require('native-peer').read();",
              [`${peer}/package.json`]: '{"name":"native-peer","main":"index.cjs"}',
              [`${peer}/index.cjs`]: `
                const fs = require('node:fs');
                const path = require('node:path');
                exports.read = () => fs.readFileSync(path.join(__dirname, 'value.txt'), 'utf8');`,
              [`${peer}/value.txt`]: "peer before",
            }
          : {}),
      });
      if (layout === "linked") {
        for (const [link, target] of [
          ["node_modules/dep", `${modules}/dep`],
          [`${modules}/native-platform`, platform],
        ]) {
          fs.symlinkSync(path.join(root, target!), path.join(root, link!), "junction");
        }
        fs.mkdirSync(path.join(root, platform, "node_modules"));
        fs.symlinkSync(
          path.join(root, peer),
          path.join(root, platform, "node_modules", "native-peer"),
          "junction",
        );
      }
      type Addon = { read(): string[] };
      const entry = path.join(root, "entry.cjs");
      const before = [
        "before",
        "before",
        ...(layout === "linked" ? ["peer before", "peer before"] : []),
      ];
      const after = [
        "after",
        "after",
        ...(layout === "linked" ? ["peer after", "peer after"] : []),
      ];
      expect((createRequire(entry)(entry) as Addon).read()).toEqual(before);
      const cache = createPluginCache();
      const first = host(root, false, cache);
      const captured = first.load("entry.cjs") as Addon;
      expect(captured.read()).toEqual(before);
      const borrowed = host(root, false, cache);
      const retained = borrowed.load("entry.cjs") as Addon;
      expect(retained.read()).toEqual(before);
      await first.dispose();
      // Reading peer data again must not depend on a retired generation's directory or JS cache.
      expect(retained.read()).toEqual(before);
      fs.writeFileSync(path.join(root, platform, "vec0.so"), "after");
      if (layout === "linked") {
        fs.writeFileSync(path.join(root, peer, "value.txt"), "peer after");
      }
      const replacement = host(root, false, cache).load("entry.cjs") as Addon;
      expect(retained.read()).toEqual(before);
      expect(replacement.read()).toEqual(after);
      await borrowed.dispose();
      expect(replacement.read()).toEqual(after);
      if (layout === "linked") {
        fs.writeFileSync(path.join(root, peer, "value.txt"), "peer newest");
        const peerOnlyReplacement = host(root, false, cache).load("entry.cjs") as Addon;
        expect(peerOnlyReplacement.read()).toEqual([
          "after",
          "after",
          "peer newest",
          "peer newest",
        ]);
        expect(replacement.read()).toEqual(after);
      }
    },
  );
});
