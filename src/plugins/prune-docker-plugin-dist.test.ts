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
  packageJson: Record<string, unknown> = {},
  sourceRoot = "extensions",
) {
  const pluginDir = path.join(repoRoot, sourceRoot, pluginId);
  fs.mkdirSync(pluginDir, { recursive: true });
  writeJsonFile(path.join(pluginDir, "package.json"), {
    name: `@openclaw/${pluginId}`,
    version: "0.0.0",
    ...packageJson,
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
  fs.mkdirSync(packageDir, { recursive: true });
  writeJsonFile(path.join(packageDir, "package.json"), {
    name: packageName,
    version: "0.0.0",
    ...packageJson,
  });
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

    const removed = pruneDockerPluginDist({
      repoRoot,
      env: { OPENCLAW_EXTENSIONS: "diagnostics-otel" } as NodeJS.ProcessEnv,
    });

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
    const pluginDir = writePluginSourcePackage(repoRoot, "acpx", {}, "plugins");

    const removed = pruneDockerPluginDist({
      repoRoot,
      env: {
        OPENCLAW_BUNDLED_PLUGIN_DIR: "plugins",
      } as NodeJS.ProcessEnv,
    });

    expect(removed).toEqual(["plugins/acpx"]);
    expect(fs.existsSync(pluginDir)).toBe(false);
  });

  it("removes node_modules dependency closure that only omitted Docker plugins need", () => {
    const repoRoot = makeRepoRoot(["acpx", "codex"], { zod: "0.0.0" });
    writePluginSourcePackage(repoRoot, "acpx", {
      dependencies: {
        "@zed-industries/codex-acp": "0.0.0",
        zod: "0.0.0",
      },
    });
    writePluginSourcePackage(repoRoot, "codex", {
      dependencies: {
        "@openai/codex": "0.0.0",
        zod: "0.0.0",
      },
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
    writeNodePackage(repoRoot, "vitest", {
      dependencies: {
        vite: "0.0.0",
      },
    });
    writeNodePackage(repoRoot, "vite", {
      dependencies: {
        postcss: "0.0.0",
      },
    });
    writeNodePackage(repoRoot, "postcss");

    const removed = pruneDockerPluginDist({
      repoRoot,
      env: { OPENCLAW_EXTENSIONS: "codex" } as NodeJS.ProcessEnv,
    });

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
      writePluginSourcePackage(repoRoot, pluginId, {
        dependencies:
          pluginId === "internal"
            ? { "root-dep": "1.0.0" }
            : { "@scope/native-cli": "1.0.0", "plain-dep": "1.0.0" },
      });
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

    const removed = pruneDockerPluginDist({
      repoRoot,
      env: { OPENCLAW_EXTENSIONS: "kept-external" } as NodeJS.ProcessEnv,
    });

    expect(removed).toEqual(["extensions/omitted-external", "dist/extensions/omitted-external"]);
    const distModules = path.join(repoRoot, "dist", "extensions", "kept-external", "node_modules");
    expect(fs.lstatSync(distModules).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(path.join(distModules, "@scope")).isSymbolicLink()).toBe(false);
    for (const [name, owner] of [
      [
        "@scope/native-cli",
        path.join(
          repoRoot,
          "node_modules/.pnpm/@scope+native-cli@1.0.0/node_modules/@scope/native-cli",
        ),
      ],
      [
        "plain-dep",
        path.join(repoRoot, "node_modules/.pnpm/plain-dep@1.0.0/node_modules/plain-dep"),
      ],
      [".bin", path.join(sourceModules, ".bin")],
    ] as const) {
      const link = path.join(distModules, name);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(path.isAbsolute(fs.readlinkSync(link))).toBe(process.platform === "win32");
      expect(fs.realpathSync(link)).toBe(owner);
    }
    const requireFromPackagedPlugin = createRequire(
      path.join(repoRoot, "dist", "extensions", "kept-external", "package.json"),
    );
    expect(requireFromPackagedPlugin.resolve("@scope/native-cli/package.json")).toBe(
      path.join(
        repoRoot,
        "node_modules/.pnpm/@scope+native-cli@1.0.0/node_modules/@scope/native-cli/package.json",
      ),
    );
    expect(
      fs.existsSync(path.join(repoRoot, "dist", "extensions", "internal", "node_modules")),
    ).toBe(false);
  });

  it("fails closed when a retained plugin dependency stays unreachable from its packaged root", () => {
    const repoRoot = makeRepoRoot(["kept-external"]);
    writeDistPluginFile(repoRoot, "dist", "kept-external");
    writePluginSourcePackage(repoRoot, "kept-external", {
      dependencies: { "absent-dep": "1.0.0" },
      optionalDependencies: { "absent-optional": "1.0.0" },
    });

    expect(() =>
      pruneDockerPluginDist({
        repoRoot,
        env: { OPENCLAW_EXTENSIONS: "kept-external" } as NodeJS.ProcessEnv,
      }),
    ).toThrow(
      /^plugin dependencies are not reachable from their packaged dist roots:\nkept-external: absent-dep$/u,
    );
  });

  it("keeps root-hoisted transitives used through a kept plugin's nested dependency", () => {
    const repoRoot = makeRepoRoot(["omitted-client"], { "shared-client": "1.0.0" });
    const keptPluginDir = writePluginSourcePackage(repoRoot, "kept-client", {
      dependencies: {
        "shared-client": "2.0.0",
      },
    });
    writePluginSourcePackage(repoRoot, "omitted-client", {
      dependencies: {
        "kept-transitive": "1.0.0",
      },
    });

    writeNodePackage(repoRoot, "shared-client", { version: "1.0.0" });
    writeNodePackage(
      repoRoot,
      "shared-client",
      {
        version: "2.0.0",
        dependencies: { "kept-transitive": "1.0.0" },
      },
      keptPluginDir,
    );
    writeNodePackage(repoRoot, "kept-transitive", { version: "1.0.0" });
    writeRequire(keptPluginDir, "index.js", "shared-client");
    writeRequire(keptPluginDir, "node_modules/shared-client/index.js", "kept-transitive");
    fs.writeFileSync(
      path.join(repoRoot, "node_modules", "kept-transitive", "index.js"),
      "module.exports = {};\n",
    );

    const removed = pruneDockerPluginDist({ repoRoot, env: {} as NodeJS.ProcessEnv });

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
      dependencies: {
        "whatwg-url": "16.0.1",
      },
    });

    writeNodePackage(repoRoot, "grammy", {
      dependencies: { "node-fetch": "2.7.0" },
    });
    writeNodePackage(repoRoot, "modern-client", {
      dependencies: { "node-fetch": "3.3.2" },
    });
    writeNodePackage(repoRoot, "node-fetch", { version: "3.3.2" });
    writeNodePackage(repoRoot, "whatwg-url", {
      version: "16.0.1",
      dependencies: { tr46: "6.0.0" },
    });
    writeNodePackage(repoRoot, "tr46", { version: "0.0.3" });

    const grammyDir = path.join(repoRoot, "node_modules", "grammy");
    writeNodePackage(
      repoRoot,
      "node-fetch",
      {
        version: "2.7.0",
        dependencies: { "whatwg-url": "5.0.0" },
      },
      grammyDir,
    );
    writeNodePackage(
      repoRoot,
      "whatwg-url",
      {
        version: "5.0.0",
        dependencies: { tr46: "0.0.3" },
      },
      grammyDir,
    );
    writeNodePackage(
      repoRoot,
      "tr46",
      { version: "6.0.0" },
      path.join(repoRoot, "node_modules", "whatwg-url"),
    );
    writeRequire(grammyDir, "index.js", "node-fetch");
    writeRequire(grammyDir, "node_modules/node-fetch/index.js", "whatwg-url");
    writeRequire(grammyDir, "node_modules/whatwg-url/index.js", "tr46");
    fs.writeFileSync(
      path.join(repoRoot, "node_modules", "tr46", "index.js"),
      "module.exports = {};\n",
    );

    const removed = pruneDockerPluginDist({ repoRoot, env: {} as NodeJS.ProcessEnv });

    expect(removed).toEqual(["node_modules/whatwg-url", "extensions/optional-client"]);
    expect(fs.existsSync(path.join(repoRoot, "node_modules", "tr46"))).toBe(true);
    const requireFromRepo = createRequire(path.join(repoRoot, "package.json"));
    expect(() => requireFromRepo("grammy")).not.toThrow();
  });
});
