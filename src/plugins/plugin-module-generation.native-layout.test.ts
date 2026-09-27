import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPluginCache } from "./plugin-cache.js";
import { createPluginModuleGenerationTestHarness } from "./plugin-module-generation.test-support.js";

const { fixture, host } = createPluginModuleGenerationTestHarness();

describe("native package library layout", () => {
  it.each(["", "lib", "build/Release"])(
    "preserves package-relative libraries for an addon in '%s' across generations",
    async (directory) => {
      const library = "node_modules/native-addon/node_modules/native-library/lib/value.dat";
      const root = fixture({
        "package.json": '{"dependencies":{"native-addon":"1.0.0"}}',
        "entry.cjs": "module.exports = require('native-addon');",
        "node_modules/native-addon/package.json": JSON.stringify({
          name: "native-addon",
          main: "index.cjs",
          dependencies: { "native-library": "1.0.0" },
        }),
        [`node_modules/native-addon/${directory ? `${directory}/` : ""}addon.node`]:
          "native fixture bytes",
        "node_modules/native-addon/index.cjs": `
          const fs = require('node:fs');
          const path = require('node:path');
          exports.read = () => {
            const native = fs.realpathSync(path.join(__dirname, ${JSON.stringify(directory)}, 'addon.node'));
            return fs.readFileSync(path.join(path.dirname(native),
              ${JSON.stringify(
                directory
                  ? directory
                      .split("/")
                      .map(() => "..")
                      .join("/")
                  : ".",
              )},
              'node_modules/native-library/lib/value.dat'), 'utf8');
          };`,
        "node_modules/native-addon/node_modules/native-library/package.json":
          '{"name":"native-library","version":"1.0.0"}',
        [library]: "before",
      });
      type Addon = { read(): string };
      const entry = path.join(root, "entry.cjs");
      expect((createRequire(entry)(entry) as Addon).read()).toBe("before");
      const cache = createPluginCache();
      const first = host(root, false, cache);
      const captured = first.load("entry.cjs") as Addon;
      expect(captured.read()).toBe("before");
      const retained = host(root, false, cache).load("entry.cjs") as Addon;
      await first.dispose();
      expect(retained.read()).toBe("before");
      fs.writeFileSync(path.join(root, library), "after");
      const replacement = host(root, false, cache).load("entry.cjs") as Addon;
      expect(retained.read()).toBe("before");
      expect(replacement.read()).toBe("after");
    },
  );

  it("rejects a native companion that escapes its package", () => {
    const external = fixture({ "value.dat": "outside the admitted package" });
    const root = fixture({
      "package.json": '{"name":"native-layout-escape"}',
      "lib/addon.node": "native fixture bytes",
      "entry.cjs":
        "module.exports = require('node:fs').realpathSync(__dirname + '/lib/addon.node');",
    });
    fs.symlinkSync(path.join(external, "value.dat"), path.join(root, "lib", "value.dat"));
    expect(() => host(root).load("entry.cjs")).toThrow(
      "Native plugin companion leaves its package",
    );
  });
});
