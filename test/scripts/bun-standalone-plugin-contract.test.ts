import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStandalonePluginContract } from "../../scripts/lib/bun-standalone-plugins.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

function fixture() {
  const root = temporary.make("standalone-plugin-contract-");
  const write = (name: string, value: unknown) => {
    const filename = path.join(root, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, JSON.stringify(value));
  };
  write("package.json", {
    exports: {
      "./plugin-sdk/core": {
        types: "./dist/plugin-sdk/core.d.ts",
        default: "./dist/plugin-sdk/core.js",
      },
      "./plugin-sdk/runtime-env": "./dist/plugin-sdk/runtime-env.js",
      "./cli": "./dist/cli.js",
    },
  });
  const plugin = (directory: string, id: string, entry = "./index.ts", setupEntry?: string) => {
    write(`dist/extensions/${directory}/openclaw.plugin.json`, { id });
    write(`dist/extensions/${directory}/package.json`, {
      openclaw: { extensions: [entry], ...(setupEntry ? { setupEntry } : {}) },
    });
  };
  plugin("zeta-package", "alpha", "./index.ts", "./setup.mts");
  plugin("alpha-package", "zeta", "./runtime.mjs");
  const plugins = {
    embedded: ["alpha", "zeta"],
    embeddedDirs: ["alpha-package", "zeta-package"],
  };
  const embeddedPaths: Record<string, string> = {
    "dist/plugin-sdk/core.js": "/image/core.mjs",
    "dist/plugin-sdk/runtime-env.js": "/image/runtime-env.mjs",
    "dist/extensions/zeta-package/index.js": "/image/alpha.mjs",
    "dist/extensions/zeta-package/setup.mjs": "/image/alpha-setup.mjs",
    "dist/extensions/alpha-package/runtime.mjs": "/image/zeta.mjs",
  };
  return { root, write, plugin, plugins, embeddedPaths };
}

describe("standalone compiled plugin contract", () => {
  it.each([
    { name: "no package manifest", manifest: undefined, filename: "index.js", setup: false },
    {
      name: "no extension metadata",
      manifest: { name: "fixture" },
      filename: "index.mjs",
      setup: false,
    },
    {
      name: "setup metadata without an extension declaration",
      manifest: { openclaw: { setupEntry: "./setup.mts" } },
      filename: "index.cjs",
      setup: true,
    },
  ])("binds the default index with $name", ({ manifest, filename, setup }) => {
    const { root, write, plugins, embeddedPaths } = fixture();
    const packagePath = "dist/extensions/zeta-package/package.json";
    if (manifest === undefined) {
      fs.unlinkSync(path.join(root, packagePath));
    } else {
      write(packagePath, manifest);
    }
    const source = `dist/extensions/zeta-package/${filename}`;
    write(source, "must not execute");
    embeddedPaths[source] = "/image/default-index.mjs";
    const contract = createStandalonePluginContract({ runtimeRoot: root, plugins, embeddedPaths });
    expect(contract.plugins.alpha).toEqual({
      runtime: [{ source, entry: "/image/default-index.mjs" }],
      ...(setup
        ? {
            setup: {
              source: "dist/extensions/zeta-package/setup.mjs",
              entry: "/image/alpha-setup.mjs",
            },
          }
        : {}),
    });
    delete embeddedPaths[source];
    expect(() =>
      createStandalonePluginContract({ runtimeRoot: root, plugins, embeddedPaths }),
    ).toThrow("Bundled plugin alpha is missing its compiled entry");
  });

  it.each([
    { name: "non-object metadata", metadata: [] },
    {
      name: "non-array entries",
      metadata: { extensions: "./index.js" },
    },
    {
      name: "empty entries",
      metadata: { extensions: [] },
    },
    {
      name: "blank entries",
      metadata: { extensions: [" "] },
    },
  ])("rejects $name even when a default index exists", ({ metadata }) => {
    const { root, write, plugins, embeddedPaths } = fixture();
    write("dist/extensions/zeta-package/package.json", { openclaw: metadata });
    write("dist/extensions/zeta-package/index.js", "must not execute");
    expect(() =>
      createStandalonePluginContract({ runtimeRoot: root, plugins, embeddedPaths }),
    ).toThrow("Bundled plugin alpha");
  });

  it("binds public SDK exports and manifest runtime/setup identities without evaluating code", () => {
    const { root, plugins, embeddedPaths } = fixture();
    expect(createStandalonePluginContract({ runtimeRoot: root, plugins, embeddedPaths })).toEqual({
      schemaVersion: 1,
      sdk: {
        "openclaw/plugin-sdk/core": { source: "dist/plugin-sdk/core.js", entry: "/image/core.mjs" },
        "openclaw/plugin-sdk/runtime-env": {
          source: "dist/plugin-sdk/runtime-env.js",
          entry: "/image/runtime-env.mjs",
        },
      },
      plugins: {
        alpha: {
          runtime: [{ source: "dist/extensions/zeta-package/index.js", entry: "/image/alpha.mjs" }],
          setup: {
            source: "dist/extensions/zeta-package/setup.mjs",
            entry: "/image/alpha-setup.mjs",
          },
        },
        zeta: {
          runtime: [
            { source: "dist/extensions/alpha-package/runtime.mjs", entry: "/image/zeta.mjs" },
          ],
        },
      },
    });
  });

  it("rejects an SDK export absent from the image instead of relying on a disk fallback", () => {
    const { root, plugins, embeddedPaths } = fixture();
    delete embeddedPaths["dist/plugin-sdk/core.js"];
    expect(() =>
      createStandalonePluginContract({ runtimeRoot: root, plugins, embeddedPaths }),
    ).toThrow(
      "Plugin SDK export ./plugin-sdk/core is missing its compiled entry: dist/plugin-sdk/core.js",
    );
  });

  it.each(["index.js", "setup.mjs"])("requires selected plugin entry %s", (filename) => {
    const { root, plugins, embeddedPaths } = fixture();
    delete embeddedPaths[`dist/extensions/zeta-package/${filename}`];
    expect(() =>
      createStandalonePluginContract({ runtimeRoot: root, plugins, embeddedPaths }),
    ).toThrow("Bundled plugin alpha is missing its compiled entry");
  });

  it("rejects escaping entries and mismatched plugin membership", () => {
    const { root, plugin, plugins, embeddedPaths } = fixture();
    plugin("zeta-package", "alpha", "../../plugin-sdk/core.js");
    expect(() =>
      createStandalonePluginContract({ runtimeRoot: root, plugins, embeddedPaths }),
    ).toThrow("Bundled plugin alpha entry is outside its package");
    plugin("zeta-package", "unselected");
    expect(() =>
      createStandalonePluginContract({ runtimeRoot: root, plugins, embeddedPaths }),
    ).toThrow("Unexpected or duplicate bundled plugin ID: unselected");
  });
});
