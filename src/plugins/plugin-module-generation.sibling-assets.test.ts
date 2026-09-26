import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { createPluginModuleGenerationTestHarness } from "./plugin-module-generation.test-support.js";

const { fixture, host } = createPluginModuleGenerationTestHarness();

describe("plugin generation sibling assets", () => {
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
            const relative = path.relative(artifact.boundaryRoot, fs.realpathSync(filename));
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
          exports.read = () => [
            fs.readFileSync(path.join(__dirname, '../native-platform/vec0.so'), 'utf8'),
            fs.readFileSync(require.resolve('native-platform/vec0.so'), 'utf8'),
          ];`,
        [`${platform}/package.json`]: '{"name":"native-platform","version":"1.0.0"}',
        [`${platform}/vec0.so`]: "before",
      });
      if (layout === "linked") {
        for (const [link, target] of [
          ["node_modules/dep", `${modules}/dep`],
          [`${modules}/native-platform`, platform],
        ]) {
          fs.symlinkSync(path.join(root, target!), path.join(root, link!), "junction");
        }
      }
      type Addon = { read(): string[] };
      const entry = path.join(root, "entry.cjs");
      expect((createRequire(entry)(entry) as Addon).read()).toEqual(["before", "before"]);
      const first = host(root);
      const captured = first.load("entry.cjs") as Addon;
      expect(captured.read()).toEqual(["before", "before"]);
      fs.writeFileSync(path.join(root, platform, "vec0.so"), "after");
      const replacement = host(root).load("entry.cjs") as Addon;
      expect(captured.read()).toEqual(["before", "before"]);
      expect(replacement.read()).toEqual(["after", "after"]);
      await first.dispose();
      expect(replacement.read()).toEqual(["after", "after"]);
    },
  );
});
