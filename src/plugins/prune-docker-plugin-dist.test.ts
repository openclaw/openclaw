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

function makeRepoRoot(excluded: string[], dependencies?: Record<string, string>): string {
  const root = makeTempRepoRoot(tempDirs, "openclaw-docker-plugin-");
  writeJsonFile(path.join(root, "package.json"), {
    files: ["dist/**", ...excluded.map((id) => `!dist/extensions/${id}/**`)],
    dependencies,
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
  dependencies?: Record<string, string>,
  options: { sourceRoot?: string; optionalDependencies?: Record<string, string> } = {},
) {
  const pluginDir = path.join(repoRoot, options.sourceRoot ?? "extensions", pluginId);
  writeJsonFile(path.join(pluginDir, "package.json"), {
    name: `@openclaw/${pluginId}`,
    version: "0.0.0",
    dependencies,
    optionalDependencies: options.optionalDependencies,
  });
  return pluginDir;
}

function expectPaths(root: string, present: string[], absent: string[] = []) {
  for (const [paths, expected] of [
    [present, true],
    [absent, false],
  ] as const) {
    for (const file of paths) {
      expect(fs.existsSync(path.join(root, file))).toBe(expected);
    }
  }
}

function writeRequire(root: string, file: string, dependency: string) {
  fs.writeFileSync(
    path.join(root, file),
    `module.exports = require(${JSON.stringify(dependency)});\n`,
  );
}

function writeNodePackage(
  repoRoot: string,
  packageName: string,
  packageJson: Record<string, unknown> = {},
  importerDir = repoRoot,
) {
  const packageDir = path.join(importerDir, "node_modules", ...packageName.split("/"));
  writeJsonFile(path.join(packageDir, "package.json"), {
    name: packageName,
    version: "0.0.0",
    ...packageJson,
  });
}

function writeNodeGraph(
  root: string,
  nodes: ReadonlyArray<readonly [string, string?, Record<string, string>?]>,
  importer = root,
) {
  for (const [name, version = "0.0.0", dependencies] of nodes) {
    writeNodePackage(root, name, { version, dependencies }, importer);
  }
}

function prune(repoRoot: string, env: NodeJS.ProcessEnv = {}) {
  return pruneDockerPluginDist({ repoRoot, env });
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

    const removed = prune(repoRoot, { OPENCLAW_EXTENSIONS: "diagnostics-otel" });

    expect(removed).toEqual([
      "extensions/feishu",
      "dist/extensions/feishu",
      "dist-runtime/extensions/feishu",
    ]);
    expectPaths(
      repoRoot,
      [
        "extensions/diagnostics-otel",
        "extensions/telegram",
        "dist/extensions/diagnostics-otel",
        "dist/extensions/telegram",
      ],
      ["extensions/feishu", "dist/extensions/feishu", "dist-runtime/extensions/feishu"],
    );
  });

  it("honors custom bundled plugin source roots when pruning Docker runtime importers", () => {
    const repoRoot = makeRepoRoot(["acpx"]);
    const pluginDir = writePluginSourcePackage(repoRoot, "acpx", undefined, {
      sourceRoot: "plugins",
    });

    const removed = prune(repoRoot, { OPENCLAW_BUNDLED_PLUGIN_DIR: "plugins" });

    expect(removed).toEqual(["plugins/acpx"]);
    expect(fs.existsSync(pluginDir)).toBe(false);
  });

  it("removes node_modules dependency closure that only omitted Docker plugins need", () => {
    const repoRoot = makeRepoRoot(["acpx", "codex"], { zod: "0.0.0" });
    writePluginSourcePackage(repoRoot, "acpx", {
      "@zed-industries/codex-acp": "0.0.0",
      zod: "0.0.0",
    });
    writePluginSourcePackage(repoRoot, "codex", {
      "@openai/codex": "0.0.0",
      zod: "0.0.0",
    });
    writeNodePackage(repoRoot, "@openclaw/acpx");
    writeNodePackage(repoRoot, "@openclaw/codex");
    writeNodePackage(repoRoot, "zod");
    writeNodePackage(repoRoot, "@openai/codex", {
      optionalDependencies: {
        "@openai/codex-linux-x64": "0.0.0",
      },
    });
    writeNodePackage(repoRoot, "@openai/codex-linux-x64");
    writeNodePackage(repoRoot, "@zed-industries/codex-acp", {
      optionalDependencies: {
        "@zed-industries/codex-acp-linux-x64": "0.0.0",
      },
      peerDependencies: {
        vitest: "0.0.0",
      },
      peerDependenciesMeta: {
        vitest: { optional: true },
      },
    });
    writeNodePackage(repoRoot, "@zed-industries/codex-acp-linux-x64");
    writeNodeGraph(repoRoot, [
      ["vitest", "0.0.0", { vite: "0.0.0" }],
      ["vite", "0.0.0", { postcss: "0.0.0" }],
      ["postcss"],
    ]);

    const removed = prune(repoRoot, { OPENCLAW_EXTENSIONS: "codex" });

    expect(removed).toEqual([
      "node_modules/@openclaw/acpx",
      "node_modules/@zed-industries/codex-acp",
      "node_modules/@zed-industries/codex-acp-linux-x64",
      "node_modules/postcss",
      "node_modules/vite",
      "node_modules/vitest",
      "extensions/acpx",
    ]);
    expectPaths(
      repoRoot,
      [
        "node_modules/zod",
        "node_modules/@openai/codex",
        "node_modules/@openai/codex-linux-x64",
        "extensions/codex",
      ],
      ["node_modules/@zed-industries", "node_modules/vitest"],
    );
  });

  it("links retained externally distributed plugin dependencies under their packaged roots", () => {
    const repoRoot = fs.realpathSync(
      makeRepoRoot(["kept-external", "omitted-external"], { "root-dep": "1.0.0" }),
    );
    writeNodePackage(repoRoot, "root-dep");
    for (const pluginId of ["kept-external", "omitted-external", "internal"]) {
      writeDistPluginFile(repoRoot, "dist", pluginId);
      writePluginSourcePackage(
        repoRoot,
        pluginId,
        pluginId === "internal"
          ? { "root-dep": "1.0.0" }
          : { "@scope/native-cli": "1.0.0", "plain-dep": "1.0.0" },
      );
    }
    // Isolated pnpm installs link plugin-local packages into the shared virtual store.
    const sourceModules = path.join(repoRoot, "extensions", "kept-external", "node_modules");
    for (const packageName of ["@scope/native-cli", "plain-dep"]) {
      const storeDir = path.join(
        repoRoot,
        "node_modules",
        ".pnpm",
        `${packageName.replace("/", "+")}@1.0.0`,
        "node_modules",
        ...packageName.split("/"),
      );
      writeJsonFile(path.join(storeDir, "package.json"), { name: packageName, version: "1.0.0" });
      const link = path.join(sourceModules, ...packageName.split("/"));
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(path.relative(path.dirname(link), storeDir), link, "dir");
    }
    fs.mkdirSync(path.join(sourceModules, ".bin"));
    fs.writeFileSync(path.join(sourceModules, ".bin", "native-cli"), "#!/bin/sh\n");

    const removed = prune(repoRoot, { OPENCLAW_EXTENSIONS: "kept-external" });

    expect(removed).toEqual(["extensions/omitted-external", "dist/extensions/omitted-external"]);
    const distModules = path.join(repoRoot, "dist", "extensions", "kept-external", "node_modules");
    expect(fs.lstatSync(distModules).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(path.join(distModules, "@scope")).isSymbolicLink()).toBe(false);
    const nativeOwner = "node_modules/.pnpm/@scope+native-cli@1.0.0/node_modules/@scope/native-cli";
    for (const [name, owner] of [
      ["@scope/native-cli", nativeOwner],
      ["plain-dep", "node_modules/.pnpm/plain-dep@1.0.0/node_modules/plain-dep"],
      [".bin", "extensions/kept-external/node_modules/.bin"],
    ] as const) {
      const link = path.join(distModules, name);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(path.isAbsolute(fs.readlinkSync(link))).toBe(process.platform === "win32");
      expect(fs.realpathSync(link)).toBe(path.join(repoRoot, owner));
    }
    const requireFromPackagedPlugin = createRequire(
      path.join(repoRoot, "dist", "extensions", "kept-external", "package.json"),
    );
    expect(requireFromPackagedPlugin.resolve("@scope/native-cli/package.json")).toBe(
      path.join(repoRoot, nativeOwner, "package.json"),
    );
    expect(
      fs.existsSync(path.join(repoRoot, "dist", "extensions", "internal", "node_modules")),
    ).toBe(false);
  });

  it("fails closed when a retained plugin dependency stays unreachable from its packaged root", () => {
    const repoRoot = makeRepoRoot(["kept-external"]);
    writeDistPluginFile(repoRoot, "dist", "kept-external");
    writePluginSourcePackage(
      repoRoot,
      "kept-external",
      { "absent-dep": "1.0.0" },
      {
        optionalDependencies: { "absent-optional": "1.0.0" },
      },
    );

    expect(() => prune(repoRoot, { OPENCLAW_EXTENSIONS: "kept-external" })).toThrow(
      /^plugin dependencies are not reachable from their packaged dist roots:\nkept-external: absent-dep$/u,
    );
  });

  it("keeps root-hoisted transitives used through a kept plugin's nested dependency", () => {
    const repoRoot = makeRepoRoot(["omitted-client"], { "shared-client": "1.0.0" });
    const keptPluginDir = writePluginSourcePackage(repoRoot, "kept-client", {
      "shared-client": "2.0.0",
    });
    writePluginSourcePackage(repoRoot, "omitted-client", {
      "kept-transitive": "1.0.0",
    });

    writeNodeGraph(repoRoot, [
      ["shared-client", "1.0.0"],
      ["kept-transitive", "1.0.0"],
    ]);
    writeNodeGraph(
      repoRoot,
      [["shared-client", "2.0.0", { "kept-transitive": "1.0.0" }]],
      keptPluginDir,
    );
    writeRequire(keptPluginDir, "index.js", "shared-client");
    writeRequire(keptPluginDir, "node_modules/shared-client/index.js", "kept-transitive");
    fs.writeFileSync(
      path.join(repoRoot, "node_modules", "kept-transitive", "index.js"),
      "module.exports = {};\n",
    );

    const removed = prune(repoRoot);

    expect(removed).toEqual(["extensions/omitted-client"]);
    const requireFromKeptPlugin = createRequire(path.join(keptPluginDir, "package.json"));
    expect(() => requireFromKeptPlugin("./index.js")).not.toThrow();
  });

  it("keeps transitive dependencies resolved through nested package versions", () => {
    const repoRoot = makeRepoRoot(["optional-client"], {
      grammy: "1.45.1",
      "modern-client": "1.0.0",
    });
    writePluginSourcePackage(repoRoot, "optional-client", {
      "whatwg-url": "16.0.1",
    });

    writeNodeGraph(repoRoot, [
      ["grammy", "0.0.0", { "node-fetch": "2.7.0" }],
      ["modern-client", "0.0.0", { "node-fetch": "3.3.2" }],
      ["node-fetch", "3.3.2"],
      ["whatwg-url", "16.0.1", { tr46: "6.0.0" }],
      ["tr46", "0.0.3"],
    ]);

    const grammyDir = path.join(repoRoot, "node_modules", "grammy");
    writeNodeGraph(
      repoRoot,
      [
        ["node-fetch", "2.7.0", { "whatwg-url": "5.0.0" }],
        ["whatwg-url", "5.0.0", { tr46: "0.0.3" }],
      ],
      grammyDir,
    );
    writeNodeGraph(
      repoRoot,
      [["tr46", "6.0.0"]],
      path.join(repoRoot, "node_modules", "whatwg-url"),
    );
    writeRequire(grammyDir, "index.js", "node-fetch");
    writeRequire(grammyDir, "node_modules/node-fetch/index.js", "whatwg-url");
    writeRequire(grammyDir, "node_modules/whatwg-url/index.js", "tr46");
    fs.writeFileSync(
      path.join(repoRoot, "node_modules", "tr46", "index.js"),
      "module.exports = {};\n",
    );

    const removed = prune(repoRoot);

    expect(removed).toEqual(["node_modules/whatwg-url", "extensions/optional-client"]);
    expect(fs.existsSync(path.join(repoRoot, "node_modules", "tr46"))).toBe(true);
    const requireFromRepo = createRequire(path.join(repoRoot, "package.json"));
    expect(() => requireFromRepo("grammy")).not.toThrow();
  });
});
