import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createPluginCache } from "./plugin-cache.js";
import { createPluginModuleGenerationTestHarness } from "./plugin-module-generation.test-support.js";

const { fixture, host } = createPluginModuleGenerationTestHarness();

it("preserves nested native package libraries across generations", async () => {
  const addon = "node_modules/native-addon";
  const library = `${addon}/node_modules/native-library/lib/value.dat`;
  const root = fixture({
    "package.json": '{"dependencies":{"native-addon":"1.0.0"}}',
    "entry.cjs": "module.exports = require('native-addon');",
    [`${addon}/package.json`]:
      '{"name":"native-addon","main":"index.cjs","dependencies":{"native-library":"1.0.0"}}',
    [`${addon}/build/Release/addon.node`]: "native fixture bytes",
    [`${addon}/index.cjs`]: `const fs = require('node:fs');
      const path = require('node:path');
      exports.read = () => {
        const native = fs.realpathSync(path.join(__dirname, 'build/Release/addon.node'));
        return fs.readFileSync(path.join(path.dirname(native),
          '../../node_modules/native-library/lib/value.dat'), 'utf8');
      };`,
    [`${addon}/node_modules/native-library/package.json`]:
      '{"name":"native-library","version":"1.0.0"}',
    [library]: "before",
  });
  type Addon = { read(): string };
  const cache = createPluginCache();
  const first = host(root, false, cache);
  expect((first.load("entry.cjs") as Addon).read()).toBe("before");
  const retained = host(root, false, cache).load("entry.cjs") as Addon;
  await first.dispose();
  expect(retained.read()).toBe("before");
  fs.writeFileSync(path.join(root, library), "after");
  const replacement = host(root, false, cache).load("entry.cjs") as Addon;
  expect(retained.read()).toBe("before");
  expect(replacement.read()).toBe("after");
});

it("rejects a native companion that escapes its package", () => {
  const external = fixture({ "value.dat": "outside the admitted package" });
  const root = fixture({
    "package.json": '{"name":"native-layout-escape"}',
    "lib/addon.node": "native fixture bytes",
    "entry.cjs": "module.exports = require('node:fs').realpathSync(__dirname + '/lib/addon.node');",
  });
  fs.symlinkSync(path.join(external, "value.dat"), path.join(root, "lib", "value.dat"));
  expect(() => host(root).load("entry.cjs")).toThrow("Native plugin companion leaves its package");
});
