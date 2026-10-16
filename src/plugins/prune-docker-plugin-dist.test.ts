import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseDockerPluginKeepList,
  pruneDockerPluginDist,
} from "../../scripts/prune-docker-plugin-dist.mjs";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { writeJsonFile } from "../../test/helpers/temp-repo.js";

type Dependencies = Record<string, string>;
type NodeSpec = readonly [name: string, version?: string, dependencies?: Dependencies];
const tempDirs: string[] = [];

function packageAt(dir: string, name: string, metadata: Record<string, unknown> = {}) {
  writeJsonFile(path.join(dir, "package.json"), { name, version: "0.0.0", ...metadata });
  return dir;
}

function fixture(excluded: string[], dependencies?: Dependencies, canonical = false) {
  const directory = makeTempDir(tempDirs, "openclaw-docker-plugin-");
  const root = canonical ? fs.realpathSync(directory) : directory;
  writeJsonFile(path.join(root, "package.json"), {
    files: ["dist/**", ...excluded.map((id) => `!dist/extensions/${id}/**`)],
    dependencies,
  });
  function node(name: string, metadata: Record<string, unknown> = {}, importer = root) {
    return packageAt(path.join(importer, "node_modules", ...name.split("/")), name, metadata);
  }
  return {
    root,
    node,
    plugin(
      id: string,
      deps?: Dependencies,
      options: { sourceRoot?: string; optionalDependencies?: Dependencies } = {},
    ) {
      return packageAt(path.join(root, options.sourceRoot ?? "extensions", id), `@openclaw/${id}`, {
        dependencies: deps,
        optionalDependencies: options.optionalDependencies,
      });
    },
    dist(id: string, kind: "dist" | "dist-runtime" = "dist") {
      writeJsonFile(path.join(root, kind, "extensions", id, "openclaw.plugin.json"), {});
    },
    graph(nodes: readonly NodeSpec[], importer = root) {
      for (const [name, version = "0.0.0", packageDependencies] of nodes) {
        node(name, { version, dependencies: packageDependencies }, importer);
      }
    },
    prune(env: NodeJS.ProcessEnv = {}) {
      return pruneDockerPluginDist({ repoRoot: root, env });
    },
  };
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

function writeModule(root: string, file: string, dependency?: string) {
  const exported = dependency ? `require(${JSON.stringify(dependency)})` : "{}";
  fs.writeFileSync(path.join(root, file), `module.exports = ${exported};\n`);
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
    const repo = fixture(["diagnostics-otel", "feishu"]);
    repo.plugin("diagnostics-otel");
    repo.plugin("feishu");
    repo.plugin("telegram");
    repo.dist("diagnostics-otel");
    repo.dist("feishu");
    repo.dist("feishu", "dist-runtime");
    repo.dist("telegram");

    const removed = repo.prune({ OPENCLAW_EXTENSIONS: "diagnostics-otel" });

    expect(removed).toEqual([
      "extensions/feishu",
      "dist/extensions/feishu",
      "dist-runtime/extensions/feishu",
    ]);
    expectPaths(
      repo.root,
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
    const repo = fixture(["acpx"]);
    const pluginDir = repo.plugin("acpx", undefined, {
      sourceRoot: "plugins",
    });

    const removed = repo.prune({ OPENCLAW_BUNDLED_PLUGIN_DIR: "plugins" });

    expect(removed).toEqual(["plugins/acpx"]);
    expect(fs.existsSync(pluginDir)).toBe(false);
  });

  it("removes node_modules dependency closure that only omitted Docker plugins need", () => {
    const repo = fixture(["acpx", "codex"], { zod: "0.0.0" });
    repo.plugin("acpx", {
      "@zed-industries/codex-acp": "0.0.0",
      zod: "0.0.0",
    });
    repo.plugin("codex", {
      "@openai/codex": "0.0.0",
      zod: "0.0.0",
    });
    repo.node("@openclaw/acpx");
    repo.node("@openclaw/codex");
    repo.node("zod");
    repo.node("@openai/codex", {
      optionalDependencies: {
        "@openai/codex-linux-x64": "0.0.0",
      },
    });
    repo.node("@openai/codex-linux-x64");
    repo.node("@zed-industries/codex-acp", {
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
    repo.node("@zed-industries/codex-acp-linux-x64");
    repo.graph([
      ["vitest", "0.0.0", { vite: "0.0.0" }],
      ["vite", "0.0.0", { postcss: "0.0.0" }],
      ["postcss"],
    ]);

    const removed = repo.prune({ OPENCLAW_EXTENSIONS: "codex" });

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
      repo.root,
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
    const repo = fixture(["kept-external", "omitted-external"], { "root-dep": "1.0.0" }, true);
    repo.node("root-dep");
    for (const pluginId of ["kept-external", "omitted-external", "internal"]) {
      repo.dist(pluginId);
      repo.plugin(
        pluginId,
        pluginId === "internal"
          ? { "root-dep": "1.0.0" }
          : { "@scope/native-cli": "1.0.0", "plain-dep": "1.0.0" },
      );
    }
    // Isolated pnpm installs link plugin-local packages into the shared virtual store.
    const sourceModules = path.join(repo.root, "extensions", "kept-external", "node_modules");
    for (const packageName of ["@scope/native-cli", "plain-dep"]) {
      const storeDir = path.join(
        repo.root,
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

    const removed = repo.prune({ OPENCLAW_EXTENSIONS: "kept-external" });

    expect(removed).toEqual(["extensions/omitted-external", "dist/extensions/omitted-external"]);
    const distModules = path.join(repo.root, "dist", "extensions", "kept-external", "node_modules");
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
      expect(fs.realpathSync(link)).toBe(path.join(repo.root, owner));
    }
    const requireFromPackagedPlugin = createRequire(
      path.join(repo.root, "dist", "extensions", "kept-external", "package.json"),
    );
    expect(requireFromPackagedPlugin.resolve("@scope/native-cli/package.json")).toBe(
      path.join(repo.root, nativeOwner, "package.json"),
    );
    expect(
      fs.existsSync(path.join(repo.root, "dist", "extensions", "internal", "node_modules")),
    ).toBe(false);
  });

  it("fails closed when a retained plugin dependency stays unreachable from its packaged root", () => {
    const repo = fixture(["kept-external"]);
    repo.dist("kept-external");
    repo.plugin(
      "kept-external",
      { "absent-dep": "1.0.0" },
      {
        optionalDependencies: { "absent-optional": "1.0.0" },
      },
    );

    expect(() => repo.prune({ OPENCLAW_EXTENSIONS: "kept-external" })).toThrow(
      /^plugin dependencies are not reachable from their packaged dist roots:\nkept-external: absent-dep$/u,
    );
  });

  it("keeps root-hoisted transitives used through a kept plugin's nested dependency", () => {
    const repo = fixture(["omitted-client"], { "shared-client": "1.0.0" });
    const keptPluginDir = repo.plugin("kept-client", {
      "shared-client": "2.0.0",
    });
    repo.plugin("omitted-client", {
      "kept-transitive": "1.0.0",
    });

    repo.graph([
      ["shared-client", "1.0.0"],
      ["kept-transitive", "1.0.0"],
    ]);
    repo.graph([["shared-client", "2.0.0", { "kept-transitive": "1.0.0" }]], keptPluginDir);
    writeModule(keptPluginDir, "index.js", "shared-client");
    writeModule(keptPluginDir, "node_modules/shared-client/index.js", "kept-transitive");
    writeModule(repo.root, "node_modules/kept-transitive/index.js");

    const removed = repo.prune();

    expect(removed).toEqual(["extensions/omitted-client"]);
    const requireFromKeptPlugin = createRequire(path.join(keptPluginDir, "package.json"));
    expect(() => requireFromKeptPlugin("./index.js")).not.toThrow();
  });

  it("keeps transitive dependencies resolved through nested package versions", () => {
    const repo = fixture(["optional-client"], {
      grammy: "1.45.1",
      "modern-client": "1.0.0",
    });
    repo.plugin("optional-client", {
      "whatwg-url": "16.0.1",
    });

    repo.graph([
      ["grammy", "0.0.0", { "node-fetch": "2.7.0" }],
      ["modern-client", "0.0.0", { "node-fetch": "3.3.2" }],
      ["node-fetch", "3.3.2"],
      ["whatwg-url", "16.0.1", { tr46: "6.0.0" }],
      ["tr46", "0.0.3"],
    ]);

    const grammyDir = path.join(repo.root, "node_modules", "grammy");
    repo.graph(
      [
        ["node-fetch", "2.7.0", { "whatwg-url": "5.0.0" }],
        ["whatwg-url", "5.0.0", { tr46: "0.0.3" }],
      ],
      grammyDir,
    );
    repo.graph([["tr46", "6.0.0"]], path.join(repo.root, "node_modules", "whatwg-url"));
    writeModule(grammyDir, "index.js", "node-fetch");
    writeModule(grammyDir, "node_modules/node-fetch/index.js", "whatwg-url");
    writeModule(grammyDir, "node_modules/whatwg-url/index.js", "tr46");
    writeModule(repo.root, "node_modules/tr46/index.js");

    const removed = repo.prune();

    expect(removed).toEqual(["node_modules/whatwg-url", "extensions/optional-client"]);
    expect(fs.existsSync(path.join(repo.root, "node_modules", "tr46"))).toBe(true);
    const requireFromRepo = createRequire(path.join(repo.root, "package.json"));
    expect(() => requireFromRepo("grammy")).not.toThrow();
  });
});
