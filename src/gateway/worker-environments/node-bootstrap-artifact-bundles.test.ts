import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { resolveNpmRunner } from "../../../scripts/npm-runner.mts";
import type { NodeBootstrapArtifactWorkerTasks } from "./node-bootstrap-artifact-contract.js";
import {
  extract,
  readText,
  useNodeBootstrapArtifactFixtures,
  write,
  writeFiles,
} from "./node-bootstrap-artifact.test-support.js";

// mock-isolation: the artifact worker suite separately covers transport.
vi.mock("./node-bootstrap-artifact-worker.js", async () => {
  const { prepareNodeBootstrapArtifact } = await import("./node-bootstrap-artifact-build.js");
  return {
    prepareNodeArtifactInWorker: (
      _kind: "bootstrap",
      { options, temporaryRoot }: NodeBootstrapArtifactWorkerTasks["bootstrap"]["input"],
    ) => prepareNodeBootstrapArtifact(options, temporaryRoot),
  };
});

const { fixture, createProvider } = useNodeBootstrapArtifactFixtures();

async function runNode(root: string) {
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(root, "openclaw.mjs")]);
  return stdout.trim();
}

describe("node bootstrap bundled dependency ownership", () => {
  it("preserves workspace bundles when npm bundling is disabled", async () => {
    const { root, packageRoot, provider, sourcePackage } = await fixture();
    await write(packageRoot, "package.json", { ...sourcePackage, bundleDependencies: false });

    const target = await extract(root, await provider.prepare());
    expect(await runNode(target)).toBe("local-ai:cloud-ready");
    const manifest = JSON.parse(await readText(target, "package.json"));
    expect(manifest.bundleDependencies).toEqual(["@fixture/ai"]);
  });

  it("installs a node artifact with a registry bundle's own dependency closure", async () => {
    const { root, packageRoot, sourcePackage, options } = await fixture();
    const name = "@fixture/codec";
    await write(packageRoot, "package.json", {
      ...sourcePackage,
      dependencies: { [name]: "1.2.3" },
      bundleDependencies: [name],
    });
    const bundledRoot = path.join(packageRoot, "node_modules", name);
    await writeFiles(bundledRoot, {
      "package.json": {
        name,
        version: "1.2.3",
        main: "index.cjs",
        dependencies: { "transitive-runtime": "^1.2.3" },
        optionalDependencies: { "unavailable-platform-runtime": "1.0.0" },
      },
      "index.cjs":
        'exports.marker = "bundle-transitive"; exports.run = () => require("transitive-runtime");',
      "node_modules/transitive-runtime/package.json": {
        name: "transitive-runtime",
        version: "1.2.3",
        main: "index.cjs",
        dependencies: { "@fixture/codec": "2.0.0" },
      },
      "node_modules/transitive-runtime/index.cjs":
        'module.exports = require("@fixture/codec").value;',
      "node_modules/transitive-runtime/node_modules/@fixture/codec/package.json": {
        name,
        version: "2.0.0",
        main: "index.cjs",
        dependencies: { "leaf-runtime": "1.2.3" },
      },
      "node_modules/transitive-runtime/node_modules/@fixture/codec/index.cjs":
        'exports.marker = "nearer-decoy"; exports.value = require("leaf-runtime");',
      "node_modules/transitive-runtime/node_modules/@fixture/codec/node_modules/leaf-runtime/package.json":
        {
          name: "leaf-runtime",
          version: "1.2.3",
          main: "index.cjs",
          dependencies: { "@fixture/codec": "1.2.3" },
        },
      "node_modules/transitive-runtime/node_modules/@fixture/codec/node_modules/leaf-runtime/index.cjs":
        'module.exports = require("@fixture/codec").marker;',
    });
    const cycleModules = path.join(
      bundledRoot,
      "node_modules/transitive-runtime/node_modules/@fixture/codec/node_modules/leaf-runtime/node_modules/@fixture",
    );
    await fs.mkdir(cycleModules, { recursive: true });
    await fs.symlink(bundledRoot, path.join(cycleModules, "codec"), "junction");
    await writeFiles(packageRoot, {
      "node_modules/transitive-runtime/package.json": {
        name: "transitive-runtime",
        version: "2.0.0",
        main: "index.cjs",
      },
      "node_modules/transitive-runtime/index.cjs": 'module.exports = "root-decoy";',
      "dist/entry.js": `import codec from "${name}"; console.log(codec.run());`,
    });
    const artifact = await createProvider({ ...options, plugins: [] }).prepare();
    const installRoot = path.join(root, "fresh-install");
    await fs.mkdir(installRoot);
    await write(installRoot, "package.json", { private: true });
    await write(installRoot, ".npmrc", "");
    const env = {
      ...Object.fromEntries(
        ["PATH", "Path", "SystemRoot", "COMSPEC", "PATHEXT"].map((key) => [key, process.env[key]]),
      ),
      HOME: installRoot,
      USERPROFILE: installRoot,
      npm_config_cache: path.join(installRoot, "empty-cache"),
      npm_config_userconfig: path.join(installRoot, ".npmrc"),
    };
    const npm = resolveNpmRunner({
      env,
      npmArgs: [
        "install",
        artifact.tarballPath,
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
    });
    await promisify(execFile)(npm.command, npm.args, {
      cwd: installRoot,
      env: npm.env ?? env,
      shell: npm.shell,
      windowsVerbatimArguments: npm.windowsVerbatimArguments,
      timeout: 30_000,
    });
    expect(await runNode(path.join(installRoot, "node_modules/openclaw"))).toBe(
      "bundle-transitive",
    );
  });

  it("runs package-owned modules under src/node_modules", async () => {
    const { root, packageRoot, provider, sourcePackage } = await fixture();
    const name = "@fixture/codec";
    await write(packageRoot, "package.json", {
      ...sourcePackage,
      dependencies: { ...sourcePackage.dependencies, [name]: "1.2.3" },
      bundleDependencies: [name],
    });
    const bundledRoot = path.join(packageRoot, "node_modules", name);
    await writeFiles(bundledRoot, {
      "package.json": {
        name,
        version: "1.2.3",
        type: "commonjs",
        main: "./src/index.js",
      },
      "src/index.js": 'module.exports = require("codec-internal");',
      "src/node_modules/codec-internal/package.json": {
        name: "codec-internal",
        version: "1.2.3",
        main: "./index.js",
      },
      "src/node_modules/codec-internal/index.js": 'module.exports = "bundled-internal";',
    });
    await write(packageRoot, "dist/entry.js", `import result from "${name}"; console.log(result);`);

    const target = await extract(root, await provider.prepare());
    expect(await runNode(target)).toBe("bundled-internal");
  });

  it.each(["source", "external-plugin"] as const)(
    "packages a plugin bundle from its own %s installation",
    async (mode) => {
      const { root, packageRoot, pluginRoot, pluginPackage, options } = await fixture(mode);
      const name = "@fixture/codec";
      const manifest = {
        ...pluginPackage,
        dependencies: { ...pluginPackage.dependencies, [name]: "1.2.3" },
        bundleDependencies: [name],
      };
      const runtimeRoot =
        mode === "source" ? path.join(packageRoot, "dist/extensions/remote-runtime") : pluginRoot;
      if (mode === "source") {
        await write(pluginRoot, "package.json", manifest);
      }
      await write(runtimeRoot, "package.json", {
        ...manifest,
        ...(mode === "external-plugin"
          ? { openclaw: { extensions: ["./index.ts"], runtimeExtensions: ["./dist/index.js"] } }
          : {}),
      });
      await write(
        runtimeRoot,
        mode === "source" ? "index.js" : "dist/index.js",
        `export { value as answer } from "${name}";`,
      );
      const dependencyManifest = {
        name,
        version: "1.2.3",
        type: "module",
        exports: { ".": "./index.js" },
      };
      const modules = mode === "source" ? pluginRoot : root;
      await writeFiles(modules, {
        [`node_modules/${name}/package.json`]: dependencyManifest,
        [`node_modules/${name}/index.js`]: 'export const value = "plugin-codec";',
      });
      const ordinaryRoot = path.join(root, "ordinary-plugin");
      await writeFiles(ordinaryRoot, {
        "package.json": {
          name: "@fixture/ordinary-runtime",
          version: pluginPackage.version,
          type: "module",
          dependencies: { [name]: "1.2.3" },
          openclaw: { extensions: ["./index.js"] },
        },
        "openclaw.plugin.json": { id: "ordinary-runtime" },
        "index.js": "export {};",
        [`node_modules/${name}/package.json`]: dependencyManifest,
        [`node_modules/${name}/index.js`]: 'export const value = "ordinary-codec";',
      });
      if (mode === "external-plugin") {
        await writeFiles(packageRoot, {
          [`node_modules/${name}/package.json`]: dependencyManifest,
          [`node_modules/${name}/index.js`]: 'export const value = "root-decoy";',
        });
      }
      const provider = createProvider({
        ...options,
        plugins: [{ id: "ordinary-runtime", root: ordinaryRoot }, ...options.plugins],
      });

      const target = await extract(root, await provider.prepare());
      expect(await runNode(target)).toBe("local-ai:plugin-codec");
    },
  );
});
