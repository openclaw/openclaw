/** Verifies Docker packaging prunes plugin dist artifacts to the supported runtime surface. */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseDockerPluginKeepList,
  pruneDockerPluginDist,
} from "../../scripts/prune-docker-plugin-dist.mjs";
import { cleanupTempDirs, makeTempDir as makeTempRepoRoot } from "../../test/helpers/temp-dir.js";
import { writeJsonFile } from "../../test/helpers/temp-repo.js";

const tempDirs: string[] = [];

function makeRepoRoot(excluded: string[], manifest: Record<string, unknown> = {}): string {
  const root = fs.realpathSync(makeTempRepoRoot(tempDirs, "openclaw-docker-plugin-"));
  writeJsonFile(path.join(root, "package.json"), {
    files: ["dist/**", ...excluded.map((id) => `!dist/extensions/${id}/**`)],
    ...manifest,
  });
  return root;
}

function writeDistPluginFile(repoRoot: string, root: "dist" | "dist-runtime", pluginId: string) {
  const pluginDir = path.join(repoRoot, root, "extensions", pluginId);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "openclaw.plugin.json"), "{}\n", "utf8");
}

function writePluginSourcePackage(
  repoRoot: string,
  pluginId: string,
  manifest: Record<string, unknown> = {},
  sourceRoot = "extensions",
) {
  const pluginDir = path.join(repoRoot, sourceRoot, pluginId);
  writeJsonFile(path.join(pluginDir, "package.json"), {
    name: `@openclaw/${pluginId}`,
    version: "0.0.0",
    ...manifest,
  });
  return pluginDir;
}

function writeNodePackage(
  importerDir: string,
  packageName: string,
  packageJson: Record<string, unknown> = {},
) {
  const packageDir = path.join(importerDir, "node_modules", ...packageName.split("/"));
  writeJsonFile(path.join(packageDir, "package.json"), {
    name: packageName,
    version: "0.0.0",
    ...packageJson,
  });
}

function writeNodePackages(importer: string, packages: Record<string, Record<string, unknown>>) {
  for (const [name, manifest] of Object.entries(packages)) {
    writeNodePackage(importer, name, manifest);
  }
}

function prune(repoRoot: string, keep = "", env: NodeJS.ProcessEnv = {}) {
  return pruneDockerPluginDist({ repoRoot, env: { OPENCLAW_EXTENSIONS: keep, ...env } });
}

function expectPaths(repoRoot: string, paths: Record<string, boolean>) {
  for (const [relative, exists] of Object.entries(paths)) {
    expect(fs.existsSync(path.join(repoRoot, relative)), relative).toBe(exists);
  }
}

function writeRequire(directory: string, dependency?: string) {
  fs.writeFileSync(
    path.join(directory, "index.js"),
    dependency ? `module.exports = require("${dependency}");\n` : "module.exports = {};\n",
  );
}

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("pruneDockerPluginDist", () => {
  it("parses space and comma separated Docker plugin keep lists", () => {
    expect([...parseDockerPluginKeepList("diagnostics-otel feishu,discord")]).toEqual([
      "diagnostics-otel",
      "feishu",
      "discord",
    ]);
  });

  it("removes package-excluded plugin runtime artifacts unless Docker explicitly opts it in", () => {
    const repoRoot = makeRepoRoot(["diagnostics-otel", "feishu"]);
    writePluginSourcePackage(repoRoot, "diagnostics-otel");
    writePluginSourcePackage(repoRoot, "feishu");
    writePluginSourcePackage(repoRoot, "telegram");
    writeDistPluginFile(repoRoot, "dist", "diagnostics-otel");
    writeDistPluginFile(repoRoot, "dist", "feishu");
    writeDistPluginFile(repoRoot, "dist-runtime", "feishu");
    writeDistPluginFile(repoRoot, "dist", "telegram");

    const removed = prune(repoRoot, "diagnostics-otel");

    expect(removed).toEqual([
      "extensions/feishu",
      "dist/extensions/feishu",
      "dist-runtime/extensions/feishu",
    ]);
    expectPaths(repoRoot, {
      "extensions/diagnostics-otel": true,
      "extensions/feishu": false,
      "extensions/telegram": true,
      "dist/extensions/diagnostics-otel": true,
      "dist/extensions/feishu": false,
      "dist-runtime/extensions/feishu": false,
      "dist/extensions/telegram": true,
    });
  });

  it("honors custom bundled plugin source roots when pruning Docker runtime importers", () => {
    const repoRoot = makeRepoRoot(["acpx"]);
    const pluginDir = writePluginSourcePackage(repoRoot, "acpx", {}, "plugins");

    const removed = prune(repoRoot, "", { OPENCLAW_BUNDLED_PLUGIN_DIR: "plugins" });

    expect(removed).toEqual(["plugins/acpx"]);
    expect(fs.existsSync(pluginDir)).toBe(false);
  });

  it("removes node_modules dependency closure that only omitted Docker plugins need", () => {
    const repoRoot = makeRepoRoot(["acpx", "codex"], {
      dependencies: { zod: "0.0.0" },
    });
    writePluginSourcePackage(repoRoot, "acpx", {
      dependencies: { "@zed-industries/codex-acp": "0.0.0", zod: "0.0.0" },
    });
    writePluginSourcePackage(repoRoot, "codex", {
      dependencies: { "@openai/codex": "0.0.0", zod: "0.0.0" },
    });
    writeNodePackages(repoRoot, {
      "@openclaw/acpx": {},
      "@openclaw/codex": {},
      zod: {},
      "@openai/codex": { optionalDependencies: { "@openai/codex-linux-x64": "0.0.0" } },
      "@openai/codex-linux-x64": {},
      "@zed-industries/codex-acp": {
        optionalDependencies: { "@zed-industries/codex-acp-linux-x64": "0.0.0" },
        peerDependencies: { vitest: "0.0.0" },
        peerDependenciesMeta: { vitest: { optional: true } },
      },
      "@zed-industries/codex-acp-linux-x64": {},
      vitest: { dependencies: { vite: "0.0.0" } },
      vite: { dependencies: { postcss: "0.0.0" } },
      postcss: {},
    });

    const removed = prune(repoRoot, "codex");

    expect(removed).toEqual([
      "node_modules/@openclaw/acpx",
      "node_modules/@zed-industries/codex-acp",
      "node_modules/@zed-industries/codex-acp-linux-x64",
      "node_modules/postcss",
      "node_modules/vite",
      "node_modules/vitest",
      "extensions/acpx",
    ]);
    expectPaths(repoRoot, {
      "node_modules/zod": true,
      "node_modules/@openai/codex": true,
      "node_modules/@openai/codex-linux-x64": true,
      "node_modules/@zed-industries": false,
      "node_modules/vitest": false,
      "extensions/codex": true,
    });
  });

  it("links retained externally distributed plugin dependencies under their packaged roots", () => {
    const repoRoot = makeRepoRoot(["kept-external", "omitted-external"], {
      name: "openclaw",
      version: "0.0.0",
      dependencies: { "root-dep": "1.0.0" },
    });
    writeNodePackage(repoRoot, "root-dep", { version: "1.0.0" });
    for (const pluginId of ["kept-external", "omitted-external", "internal"]) {
      writeDistPluginFile(repoRoot, "dist", pluginId);
      writePluginSourcePackage(repoRoot, pluginId, {
        dependencies:
          pluginId === "internal"
            ? { "root-dep": "1.0.0" }
            : { "@scope/native-cli": "1.0.0", "plain-dep": "1.0.0" },
        ...(pluginId === "kept-external"
          ? {
              bundleDependencies: ["plain-dep"],
              optionalDependencies: {
                "missing-native": "1.0.0",
                "optional-native": "1.0.0",
              },
            }
          : {}),
      });
    }
    // Isolated pnpm installs link plugin-local packages into the shared virtual store.
    const sourceModules = path.join(repoRoot, "extensions", "kept-external", "node_modules");
    const storedPackage = (name: string) =>
      path.join(
        repoRoot,
        "node_modules/.pnpm",
        `${name.replace("/", "+")}@1.0.0/node_modules`,
        name,
      );
    for (const packageName of ["@scope/native-cli", "optional-native", "plain-dep"]) {
      const storeDir = storedPackage(packageName);
      writeJsonFile(path.join(storeDir, "package.json"), { name: packageName, version: "1.0.0" });
      const link = path.join(sourceModules, ...packageName.split("/"));
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(path.relative(path.dirname(link), storeDir), link, "dir");
    }
    fs.mkdirSync(path.join(sourceModules, ".bin"));
    fs.writeFileSync(path.join(sourceModules, ".bin", "native-cli"), "#!/bin/sh\n");

    const removed = prune(repoRoot, "kept-external");

    expect(removed).toEqual(["extensions/omitted-external", "dist/extensions/omitted-external"]);
    expect(JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"))).toMatchObject({
      files: ["dist/**", "!dist/extensions/omitted-external/**"],
      bundleDependencies: ["plain-dep"],
      dependencies: {
        "@scope/native-cli": "1.0.0",
        "plain-dep": "1.0.0",
        "root-dep": "1.0.0",
      },
      optionalDependencies: {
        "missing-native": "1.0.0",
        "optional-native": "1.0.0",
      },
    });
    const distModules = path.join(repoRoot, "dist", "extensions", "kept-external", "node_modules");
    expect(fs.lstatSync(distModules).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(path.join(distModules, "@scope")).isSymbolicLink()).toBe(false);
    for (const name of ["@scope/native-cli", "plain-dep", ".bin"]) {
      const owner = name === ".bin" ? path.join(sourceModules, name) : storedPackage(name);
      const link = path.join(distModules, name);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(path.isAbsolute(fs.readlinkSync(link))).toBe(process.platform === "win32");
      expect(fs.realpathSync(link)).toBe(owner);
    }
    const requireFromPackagedPlugin = createRequire(
      path.join(repoRoot, "dist", "extensions", "kept-external", "package.json"),
    );
    expect(requireFromPackagedPlugin.resolve("@scope/native-cli/package.json")).toBe(
      path.join(storedPackage("@scope/native-cli"), "package.json"),
    );
    const requireFromRoot = createRequire(path.join(repoRoot, "package.json"));
    for (const packageName of ["@scope/native-cli", "optional-native", "plain-dep"]) {
      expect(requireFromRoot.resolve(`${packageName}/package.json`)).toBe(
        fs.realpathSync(path.join(sourceModules, packageName, "package.json")),
      );
    }
    expect(() => requireFromRoot.resolve("missing-native/package.json")).toThrow();
    expect(
      fs.existsSync(path.join(repoRoot, "dist", "extensions", "internal", "node_modules")),
    ).toBe(false);
  });

  it("refuses to replace a different installed root dependency selected by a plugin", () => {
    const repoRoot = makeRepoRoot(["kept-external"], {
      name: "openclaw",
      version: "0.0.0",
      dependencies: { shared: "1.0.0" },
    });
    writeNodePackage(repoRoot, "shared", { version: "1.0.0" });
    writeDistPluginFile(repoRoot, "dist", "kept-external");
    const pluginDir = writePluginSourcePackage(repoRoot, "kept-external", {
      dependencies: { shared: "2.0.0" },
    });
    writeNodePackage(pluginDir, "shared", { version: "2.0.0" });
    const originalManifest = fs.readFileSync(path.join(repoRoot, "package.json"));
    const originalRootBinding = fs.realpathSync(path.join(repoRoot, "node_modules", "shared"));

    expect(() => prune(repoRoot, "kept-external")).toThrow(
      /root package\.json must declare shared@2\.0\.0/u,
    );

    expect(fs.readFileSync(path.join(repoRoot, "package.json"))).toEqual(originalManifest);
    expect(fs.realpathSync(path.join(repoRoot, "node_modules", "shared"))).toBe(
      originalRootBinding,
    );
  });

  it("fails closed when a retained plugin dependency stays unreachable from its packaged root", () => {
    const repoRoot = makeRepoRoot(["kept-external"]);
    writeDistPluginFile(repoRoot, "dist", "kept-external");
    writePluginSourcePackage(repoRoot, "kept-external", {
      dependencies: { "absent-dep": "1.0.0" },
      optionalDependencies: { "absent-optional": "1.0.0" },
    });

    expect(() => prune(repoRoot, "kept-external")).toThrow(
      /^plugin dependencies are not reachable from their packaged dist roots:\nkept-external: absent-dep$/u,
    );
  });

  it("keeps root-hoisted transitives used through a kept plugin's nested dependency", () => {
    const repoRoot = makeRepoRoot(["omitted-client"], {
      dependencies: { "shared-client": "1.0.0" },
    });
    const keptPluginDir = writePluginSourcePackage(repoRoot, "kept-client", {
      dependencies: { "shared-client": "2.0.0" },
    });
    writePluginSourcePackage(repoRoot, "omitted-client", {
      dependencies: { "kept-transitive": "1.0.0" },
    });

    writeNodePackage(repoRoot, "shared-client", { version: "1.0.0" });
    writeNodePackage(keptPluginDir, "shared-client", {
      version: "2.0.0",
      dependencies: { "kept-transitive": "1.0.0" },
    });
    writeNodePackage(repoRoot, "kept-transitive", { version: "1.0.0" });
    writeRequire(keptPluginDir, "shared-client");
    writeRequire(path.join(keptPluginDir, "node_modules", "shared-client"), "kept-transitive");
    writeRequire(path.join(repoRoot, "node_modules", "kept-transitive"));

    const removed = prune(repoRoot);

    expect(removed).toEqual(["extensions/omitted-client"]);
    const requireFromKeptPlugin = createRequire(path.join(keptPluginDir, "package.json"));
    expect(() => requireFromKeptPlugin("./index.js")).not.toThrow();
  });

  it("keeps transitive dependencies resolved through nested package versions", () => {
    const repoRoot = makeRepoRoot(["optional-client"], {
      dependencies: {
        grammy: "1.45.1",
        "modern-client": "1.0.0",
      },
    });
    writePluginSourcePackage(repoRoot, "optional-client", {
      dependencies: { "whatwg-url": "16.0.1" },
    });

    writeNodePackages(repoRoot, {
      grammy: { dependencies: { "node-fetch": "2.7.0" } },
      "modern-client": { dependencies: { "node-fetch": "3.3.2" } },
      "node-fetch": { version: "3.3.2" },
      "whatwg-url": { version: "16.0.1", dependencies: { tr46: "6.0.0" } },
      tr46: { version: "0.0.3" },
    });

    const grammyDir = path.join(repoRoot, "node_modules", "grammy");
    writeNodePackages(grammyDir, {
      "node-fetch": { version: "2.7.0", dependencies: { "whatwg-url": "5.0.0" } },
      "whatwg-url": { version: "5.0.0", dependencies: { tr46: "0.0.3" } },
    });
    writeNodePackage(path.join(repoRoot, "node_modules", "whatwg-url"), "tr46", {
      version: "6.0.0",
    });
    writeRequire(grammyDir, "node-fetch");
    writeRequire(path.join(grammyDir, "node_modules", "node-fetch"), "whatwg-url");
    writeRequire(path.join(grammyDir, "node_modules", "whatwg-url"), "tr46");
    writeRequire(path.join(repoRoot, "node_modules", "tr46"));

    const removed = prune(repoRoot);

    expect(removed).toEqual(["node_modules/whatwg-url", "extensions/optional-client"]);
    expect(fs.existsSync(path.join(repoRoot, "node_modules", "tr46"))).toBe(true);
    const requireFromRepo = createRequire(path.join(repoRoot, "package.json"));
    expect(() => requireFromRepo("grammy")).not.toThrow();
  });
});
