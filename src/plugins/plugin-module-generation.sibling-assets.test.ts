import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { resolveStateDir } from "../config/state-dir.js";
import { listDirectoryTreeStrictSync } from "../infra/directory-walk.js";
import { createPluginCache } from "./plugin-cache.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { createPluginModuleGenerationTestHarness } from "./plugin-module-generation.test-support.js";

const { fixture, host } = createPluginModuleGenerationTestHarness();
const companion = "original real-directory companion";
const helper = 'exports.value = "late";';
function nativeAlias() {
  const root = fixture({
    "package.json": '{"name":"native-alias-fixture","dependencies":{"dep":"1.0.0"}}',
    "platform/addon.node": "native fixture bytes",
    "platform/helper.dat": companion,
    "platform/helper.cjs": helper,
    "node_modules/dep/package.json": '{"name":"dep","main":"index.cjs"}',
    "node_modules/dep/index.cjs": "exports.value = 'dep';",
    // Published packages can contain unused projects whose dependencies aren't installed.
    "node_modules/dep/benchmark/package.json":
      '{"private":true,"dependencies":{"openclaw-absent-benchmark-fixture":"1.0.0"}}',
    "node_modules/dep/benchmark/bench.mjs": "import 'openclaw-absent-benchmark-fixture';",
    "entry.cjs": `
        const fs = require('node:fs');
        const path = require('node:path');
        exports.native = fs.realpathSync(path.join(__dirname, 'bin', 'addon.node'));
        exports.read = name => [require('dep').value,
          fs.readFileSync(path.join(path.dirname(exports.native), 'helper.dat'), 'utf8'),
          require(name).value];`,
  });
  fs.mkdirSync(path.join(root, "bin"));
  fs.symlinkSync("../platform/addon.node", path.join(root, "bin", "addon.node"), "file");
  return root;
}

it.each([false, true])(
  "handles a native alias companion directory (file symlinks denied: %s)",
  (denyFileSymlinks) => {
    const root = nativeAlias();
    type NativeCompanion = { native: string; read(name: string): string[] };
    const entry = path.join(root, "entry.cjs");
    const read = (api: NativeCompanion) => api.read("./platform/helper.cjs");
    const expected = ["dep", companion, "late"];
    expect(read(createRequire(entry)(entry) as NativeCompanion)).toEqual(expected);
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
    const sibling = path.join(path.dirname(captured.native), "helper.cjs");
    // Native execution can request the source companion before JavaScript imports it.
    expect(fs.existsSync(sibling)).toBe(true);
    fs.writeFileSync(path.join(root, "platform", "helper.dat"), "replacement companion");
    fs.writeFileSync(path.join(root, "platform", "helper.cjs"), 'exports.value = "edited";');
    expect(read(captured)).toEqual(expected);
    expect(fs.readFileSync(sibling, "utf8")).toBe(helper);
  },
);

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
    for (const entry of listDirectoryTreeStrictSync(artifact.boundaryRoot).map(
      (walkEntry) => walkEntry.dirent,
    )) {
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

it("preserves linked optional native siblings and peers across generations", async () => {
  const modules = "node_modules/.pnpm/dep@1/node_modules";
  const platform = "node_modules/.pnpm/native-platform@1/node_modules/native-platform";
  const peer = "node_modules/.pnpm/native-peer@1/node_modules/native-peer";
  const root = fixture({
    "package.json": '{"dependencies":{"dep":"1.0.0"}}',
    "entry.cjs": "module.exports = require('dep');",
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
              require('native-platform/helper.cjs').read(),
              createRequire(native)(path.join(path.dirname(native), 'helper.cjs')).read(),
            ];
          };`,
    [`${platform}/package.json`]: JSON.stringify({
      name: "native-platform",
      version: "1.0.0",
      peerDependencies: { "native-peer": "1.0.0" },
    }),
    [`${platform}/vec0.so`]: "before",
    [`${platform}/helper.cjs`]: "exports.read = () => require('native-peer').read();",
    [`${peer}/package.json`]: '{"name":"native-peer","main":"index.cjs"}',
    [`${peer}/index.cjs`]: `
                const fs = require('node:fs');
                const path = require('node:path');
                exports.read = () => fs.readFileSync(path.join(__dirname, 'value.txt'), 'utf8');`,
    [`${peer}/value.txt`]: "peer before",
  });
  const link = (name: string, target: string) => {
    const filename = path.join(root, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.symlinkSync(path.join(root, target), filename, "junction");
  };
  link("node_modules/dep", `${modules}/dep`);
  link(`${modules}/native-platform`, platform);
  link(`${platform}/node_modules/native-peer`, peer);
  type Addon = { read(): string[] };
  const entry = path.join(root, "entry.cjs");
  const values = (native: string, peerValue = `peer ${native}`) => [
    native,
    native,
    peerValue,
    peerValue,
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
  fs.writeFileSync(path.join(root, peer, "value.txt"), "peer after");
  const replacement = host(root, false, cache).load("entry.cjs") as Addon;
  expect(retained.read()).toEqual(before);
  expect(replacement.read()).toEqual(after);
  await borrowed.dispose();
  expect(replacement.read()).toEqual(after);
  fs.writeFileSync(path.join(root, peer, "value.txt"), "peer newest");
  const peerOnlyReplacement = host(root, false, cache).load("entry.cjs") as Addon;
  expect(peerOnlyReplacement.read()).toEqual(values("after", "peer newest"));
  expect(replacement.read()).toEqual(after);
});
