import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { resolveStateDir } from "../config/state-dir.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPluginCache, retirePluginCache } from "./plugin-cache.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { createPluginModuleGenerationTestHarness } from "./plugin-module-generation.test-support.js";

const { fixture, host } = createPluginModuleGenerationTestHarness();
const companion = "original real-directory companion";
function nativeAlias(
  files: Record<string, string> = {},
  read = "fs.readFileSync(path.join(path.dirname(native), 'helper.dat'), 'utf8')",
) {
  const root = fixture({
    "package.json": '{"name":"native-alias-fixture"}',
    "platform/addon.node": "native fixture bytes",
    "platform/helper.dat": companion,
    "entry.cjs": `
        const fs = require('node:fs');
        const path = require('node:path');
        exports.read = () => {
          const native = fs.realpathSync(path.join(__dirname, 'bin', 'addon.node'));
          return ${read};
        };`,
    ...files,
  });
  fs.mkdirSync(path.join(root, "bin"));
  fs.symlinkSync("../platform/addon.node", path.join(root, "bin", "addon.node"), "file");
  return root;
}

it.each([false, true])(
  "handles a native alias companion directory (file symlinks denied: %s)",
  (denyFileSymlinks) => {
    const root = nativeAlias();
    type NativeCompanion = { read(): string };
    const entry = path.join(root, "entry.cjs");
    expect((createRequire(entry)(entry) as NativeCompanion).read()).toBe(companion);
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
    expect(captured.read()).toBe(companion);
    fs.writeFileSync(path.join(root, "platform", "helper.dat"), "replacement companion");
    expect(captured.read()).toBe(companion);
  },
);

it("does not require dependencies of a dependency's unused nested subproject", () => {
  const root = nativeAlias(
    {
      "package.json": '{"name":"native-scope-fixture","dependencies":{"dep":"1.0.0"}}',
      "platform/helper.dat": "companion",
      "node_modules/dep/package.json": '{"name":"dep","main":"index.cjs"}',
      "node_modules/dep/index.cjs": "exports.value = 'dep';",
      // Published packages ship private benchmark projects whose dependencies are never installed.
      "node_modules/dep/benchmark/package.json":
        '{"private":true,"dependencies":{"openclaw-absent-benchmark-fixture":"1.0.0"}}',
      "node_modules/dep/benchmark/bench.mjs": "import 'openclaw-absent-benchmark-fixture';",
    },
    "[require('dep').value, fs.readFileSync(path.join(path.dirname(native), 'helper.dat'), 'utf8')]",
  );
  const captured = host(root, true).load("entry.cjs") as { read(): string[] };
  expect(captured.read()).toEqual(["dep", "companion"]);
});

it("keeps computed source siblings beside the admitted native realpath", async () => {
  await withOpenClawTestState({ label: "native-lazy-companion" }, async () => {
    const helper = 'exports.value = "late";';
    const root = fixture({
      "package.json": '{"name":"native-lazy-fixture"}',
      "tool.bin": "native fixture bytes",
      "helper.cjs": helper,
      "index.cjs": `const fs = require('node:fs');
         const path = require('node:path');
         exports.native = fs.realpathSync(path.join(__dirname, 'tool.bin'));
         exports.read = name => require(name).value;`,
    });
    const cache = createPluginCache();
    const instance = host(root, true, cache);
    try {
      const api = instance.load("index.cjs") as { native: string; read(name: string): string };
      const sibling = path.join(path.dirname(api.native), "helper.cjs");
      // Native execution can request any sibling before JavaScript imports that companion.
      expect(fs.existsSync(sibling)).toBe(true);
      fs.writeFileSync(path.join(root, "helper.cjs"), 'exports.value = "edited after admission";');
      expect(api.read("./helper.cjs")).toBe("late");
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
    for (const entry of fs.readdirSync(artifact.boundaryRoot, {
      withFileTypes: true,
      recursive: true,
    })) {
      const filename = path.join(entry.parentPath, entry.name);
      if (entry.isSymbolicLink()) {
        const boundary =
          entry.name === "vec0.so"
            ? path.join(resolveStateDir(), "tmp", "plugin-captures")
            : artifact.boundaryRoot;
        const relative = path.relative(boundary, fs.realpathSync(filename));
        expect(relative).not.toBe("..");
        expect(relative.startsWith(`..${path.sep}`)).toBe(false);
        expect(path.isAbsolute(relative)).toBe(false);
      }
    }
    const capturedExternal = artifact.sourceAliases[fs.realpathSync(external)];
    fs.writeFileSync(path.join(external, "vec0.so"), "changed external source");
    expect(fs.readFileSync(path.join(capturedExternal!, "vec0.so"), "utf8")).toBe(
      "external fixture bytes",
    );
  } finally {
    artifact.dispose();
  }
});

it.each(["hoisted", "nested", "linked"] as const)(
  "preserves optional native siblings in a %s install across generations",
  async (layout) => {
    const linked = layout === "linked";
    const modules = {
      nested: "node_modules/parent/node_modules",
      linked: "node_modules/.pnpm/dep@1/node_modules",
      hoisted: "node_modules",
    }[layout];
    const platform = linked
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
                linked
                  ? `require('native-platform/helper.cjs').read(),
                     createRequire(native)(path.join(path.dirname(native), 'helper.cjs')).read(),`
                  : ""
              }
            ];
          };`,
      [`${platform}/package.json`]: JSON.stringify({
        name: "native-platform",
        version: "1.0.0",
        ...(linked ? { peerDependencies: { "native-peer": "1.0.0" } } : {}),
      }),
      [`${platform}/vec0.so`]: "before",
      ...(linked
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
    if (linked) {
      const link = (name: string, target: string) => {
        const filename = path.join(root, name);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.symlinkSync(path.join(root, target), filename, "junction");
      };
      link("node_modules/dep", `${modules}/dep`);
      link(`${modules}/native-platform`, platform);
      link(`${platform}/node_modules/native-peer`, peer);
    }
    type Addon = { read(): string[] };
    const entry = path.join(root, "entry.cjs");
    const values = (native: string, peerValue = `peer ${native}`) => [
      native,
      native,
      ...(linked ? [peerValue, peerValue] : []),
    ];
    const before = values("before");
    const after = values("after");
    expect((createRequire(entry)(entry) as Addon).read()).toEqual(before);
    const cache = createPluginCache();
    const first = host(root, false, cache);
    expect((first.load("entry.cjs") as Addon).read()).toEqual(before);
    const borrowed = host(root, false, cache);
    const retained = borrowed.load("entry.cjs") as Addon;
    expect(retained.read()).toEqual(before);
    await first.dispose();
    // Reading peer data again must not depend on a retired generation's directory or JS cache.
    expect(retained.read()).toEqual(before);
    fs.writeFileSync(path.join(root, platform, "vec0.so"), "after");
    if (linked) {
      fs.writeFileSync(path.join(root, peer, "value.txt"), "peer after");
    }
    const replacement = host(root, false, cache).load("entry.cjs") as Addon;
    expect(retained.read()).toEqual(before);
    expect(replacement.read()).toEqual(after);
    await borrowed.dispose();
    expect(replacement.read()).toEqual(after);
    if (linked) {
      fs.writeFileSync(path.join(root, peer, "value.txt"), "peer newest");
      const peerOnlyReplacement = host(root, false, cache).load("entry.cjs") as Addon;
      expect(peerOnlyReplacement.read()).toEqual(values("after", "peer newest"));
      expect(replacement.read()).toEqual(after);
    }
  },
);
