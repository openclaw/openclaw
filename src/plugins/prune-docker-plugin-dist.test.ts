/** Verifies Docker packaging prunes plugin dist artifacts to the supported runtime surface. */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseDockerPluginKeepList,
  pruneDockerPluginDist,
} from "../../scripts/prune-docker-plugin-dist.mjs";
import { cleanupTempDirs, makeTempDir as makeTempRepoRoot } from "../../test/helpers/temp-dir.js";
import { writeJsonFile } from "../../test/helpers/temp-repo.js";
import { assertArtifactTreeReadable } from "../shared/artifact-permissions.js";

const tempDirs: string[] = [];

function makeRepoRoot(prefix: string): string {
  return makeTempRepoRoot(tempDirs, prefix);
}

function writeDistPluginFile(repoRoot: string, root: "dist" | "dist-runtime", pluginId: string) {
  const pluginDir = path.join(repoRoot, root, "extensions", pluginId);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "openclaw.plugin.json"), "{}\n", "utf8");
}

function writePluginSourcePackage(repoRoot: string, pluginId: string) {
  const pluginDir = path.join(repoRoot, "extensions", pluginId);
  fs.mkdirSync(pluginDir, { recursive: true });
  writeJsonFile(path.join(pluginDir, "package.json"), {
    name: `@openclaw/${pluginId}`,
    version: "0.0.0",
  });
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
    const repoRoot = makeRepoRoot("openclaw-docker-plugin-dist-");
    writeJsonFile(path.join(repoRoot, "package.json"), {
      files: ["dist/**", "!dist/extensions/diagnostics-otel/**", "!dist/extensions/feishu/**"],
    });
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
    expect(fs.existsSync(path.join(repoRoot, "extensions", "diagnostics-otel"))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, "extensions", "feishu"))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, "extensions", "telegram"))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, "dist", "extensions", "diagnostics-otel"))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, "dist", "extensions", "feishu"))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, "dist-runtime", "extensions", "feishu"))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, "dist", "extensions", "telegram"))).toBe(true);
  });

  it("honors custom bundled plugin source roots when pruning Docker runtime importers", () => {
    const repoRoot = makeRepoRoot("openclaw-docker-plugin-source-");
    writeJsonFile(path.join(repoRoot, "package.json"), {
      files: ["dist/**", "!dist/extensions/acpx/**"],
    });
    const pluginDir = path.join(repoRoot, "plugins", "acpx");
    fs.mkdirSync(pluginDir, { recursive: true });
    writeJsonFile(path.join(pluginDir, "package.json"), {
      name: "@openclaw/acpx",
      version: "0.0.0",
    });

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
    const repoRoot = makeRepoRoot("openclaw-docker-plugin-node-modules-");
    writeJsonFile(path.join(repoRoot, "package.json"), {
      files: ["dist/**", "!dist/extensions/acpx/**", "!dist/extensions/codex/**"],
      dependencies: {
        zod: "0.0.0",
      },
    });
    writeJsonFile(path.join(repoRoot, "extensions", "acpx", "package.json"), {
      name: "@openclaw/acpx",
      version: "0.0.0",
      dependencies: {
        "@zed-industries/codex-acp": "0.0.0",
        zod: "0.0.0",
      },
    });
    writeJsonFile(path.join(repoRoot, "extensions", "codex", "package.json"), {
      name: "@openclaw/codex",
      version: "0.0.0",
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
    expect(fs.existsSync(path.join(repoRoot, "node_modules", "zod"))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, "node_modules", "@openai", "codex"))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, "node_modules", "@openai", "codex-linux-x64"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(repoRoot, "node_modules", "@zed-industries"))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, "node_modules", "vitest"))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, "extensions", "codex"))).toBe(true);
  });

  it("links retained externally distributed plugin dependencies under their packaged roots", () => {
    const repoRoot = fs.realpathSync(makeRepoRoot("openclaw-docker-plugin-dist-links-"));
    writeJsonFile(path.join(repoRoot, "package.json"), {
      files: [
        "dist/**",
        "!dist/extensions/kept-external/**",
        "!dist/extensions/omitted-external/**",
      ],
      dependencies: { "root-dep": "1.0.0" },
    });
    writeNodePackage(repoRoot, "root-dep");
    for (const pluginId of ["kept-external", "omitted-external", "internal"]) {
      writeDistPluginFile(repoRoot, "dist", pluginId);
      writeJsonFile(path.join(repoRoot, "extensions", pluginId, "package.json"), {
        name: `@openclaw/${pluginId}`,
        version: "0.0.0",
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

  // Docker uses relocatable POSIX links; Windows staging intentionally uses absolute junctions.
  it.skipIf(process.platform === "win32")(
    "retains selected plugin workspace dependencies in the final Docker image projection",
    () => {
      const repoRoot = fs.realpathSync(makeRepoRoot("openclaw-docker-workspace-runtime-"));
      writeJsonFile(path.join(repoRoot, "package.json"), {
        files: ["dist/**", "!dist/extensions/workboard/**", "!dist/extensions/omitted/**"],
      });
      const linkPackage = (importer: string, name: string, target: string) => {
        const link = path.join(importer, "node_modules", ...name.split("/"));
        fs.mkdirSync(path.dirname(link), { recursive: true });
        fs.symlinkSync(path.relative(path.dirname(link), target), link, "dir");
      };
      const protocolDir = path.join(repoRoot, "packages", "gateway-protocol");
      const contractDir = path.join(repoRoot, "packages", "workboard-contract");
      writeJsonFile(path.join(protocolDir, "package.json"), {
        name: "@openclaw/gateway-protocol",
        exports: "./dist/index.cjs",
        dependencies: { typebox: "1.0.0" },
        devDependencies: { "dev-only": "1.0.0" },
      });
      writeJsonFile(path.join(contractDir, "package.json"), {
        name: "@openclaw/workboard-contract",
        exports: "./src/index.cjs",
        dependencies: { "@openclaw/gateway-protocol": "workspace:*" },
      });
      fs.mkdirSync(path.join(protocolDir, "dist"));
      fs.writeFileSync(
        path.join(protocolDir, "dist/index.cjs"),
        'module.exports = require("typebox");\n',
      );
      fs.mkdirSync(path.join(contractDir, "src"));
      fs.writeFileSync(
        path.join(contractDir, "src/index.cjs"),
        'module.exports = require("@openclaw/gateway-protocol");\n',
      );
      const storeRoot = path.join(repoRoot, "node_modules", ".pnpm");
      const dependencyOwners = new Map<string, string>();
      for (const name of ["typebox", "plugin-only", "sibling-only"]) {
        const importer = path.join(storeRoot, `${name}@1.0.0`);
        writeNodePackage(repoRoot, name, {}, importer);
        const owner = path.join(importer, "node_modules", name);
        fs.writeFileSync(
          path.join(owner, "index.js"),
          `module.exports = ${JSON.stringify(name)};\n`,
        );
        dependencyOwners.set(name, owner);
      }
      linkPackage(protocolDir, "typebox", dependencyOwners.get("typebox")!);
      linkPackage(contractDir, "@openclaw/gateway-protocol", protocolDir);
      const workboardDir = path.join(repoRoot, "extensions", "workboard");
      writeJsonFile(path.join(workboardDir, "package.json"), {
        name: "@openclaw/workboard",
        dependencies: {
          "@openclaw/gateway-protocol": "workspace:*",
          "@openclaw/workboard-contract": "workspace:*",
          "plugin-only": "1.0.0",
        },
      });
      linkPackage(workboardDir, "@openclaw/gateway-protocol", protocolDir);
      linkPackage(workboardDir, "@openclaw/workboard-contract", contractDir);
      linkPackage(workboardDir, "plugin-only", dependencyOwners.get("plugin-only")!);
      const pluginEntry =
        'module.exports = { protocol: require("@openclaw/gateway-protocol"), contract: require("@openclaw/workboard-contract"), ordinary: require("plugin-only") };\n';
      fs.writeFileSync(path.join(workboardDir, "index.cjs"), pluginEntry);
      writeDistPluginFile(repoRoot, "dist", "workboard");
      fs.writeFileSync(path.join(repoRoot, "dist/extensions/workboard/index.cjs"), pluginEntry);
      const siblingDir = path.join(repoRoot, "extensions", "sibling");
      writeJsonFile(path.join(siblingDir, "package.json"), {
        name: "@openclaw/sibling",
        dependencies: { "sibling-only": "1.0.0" },
      });
      linkPackage(siblingDir, "sibling-only", dependencyOwners.get("sibling-only")!);
      writePluginSourcePackage(repoRoot, "omitted");
      writeDistPluginFile(repoRoot, "dist", "omitted");
      const uiDir = path.join(repoRoot, "ui");
      writeJsonFile(path.join(uiDir, "package.json"), { name: "openclaw-control-ui" });
      const aggregateImporter = path.join(repoRoot, "node_modules", ".pnpm");
      linkPackage(aggregateImporter, "openclaw-control-ui", uiDir);
      linkPackage(
        aggregateImporter,
        "@openclaw/omitted",
        path.join(repoRoot, "extensions/omitted"),
      );
      linkPackage(aggregateImporter, "@openclaw/gateway-protocol", protocolDir);
      // Aliases are not limited to the aggregate root; importer-local and chained
      // aliases must be classified while their canonical workspace target exists.
      linkPackage(protocolDir, "dev-ui", uiDir);
      linkPackage(workboardDir, "dev-ui", uiDir);
      linkPackage(dependencyOwners.get("plugin-only")!, "dev-ui", uiDir);
      linkPackage(
        repoRoot,
        "ui-alias",
        path.join(aggregateImporter, "node_modules/openclaw-control-ui"),
      );

      pruneDockerPluginDist({ repoRoot, env: { OPENCLAW_EXTENSIONS: "workboard" } });

      const dockerfile = fs.readFileSync(
        fileURLToPath(new URL("../../Dockerfile", import.meta.url)),
        "utf8",
      );
      // Only the final stage's literal runtime-assets COPY operations project the image;
      // earlier stages intentionally contain all workspaces and cannot prove retention.
      const finalStage = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
      const copies = [
        ...finalStage.matchAll(
          /^COPY --from=runtime-assets --chown=node:node \/app\/(\S+) (\S+)$/gmu,
        ),
      ].map(([, source, target]) => {
        if (!source || !target) {
          throw new Error("Docker runtime COPY must have a source and destination");
        }
        return {
          source: source.replace("${OPENCLAW_BUNDLED_PLUGIN_DIR}", "extensions"),
          target: target.replace("${OPENCLAW_BUNDLED_PLUGIN_DIR}", "extensions"),
        };
      });
      expect(copies.map(({ source }) => source)).toEqual(
        expect.arrayContaining(["dist", "node_modules", "extensions"]),
      );
      const project = (includeWorkspaces: boolean) => {
        const imageRoot = fs.realpathSync(makeRepoRoot("openclaw-docker-final-projection-"));
        for (const { source, target } of copies) {
          const sourcePath = path.join(repoRoot, source);
          if ((!includeWorkspaces && source === "packages") || !fs.existsSync(sourcePath)) {
            continue;
          }
          const destination = path.join(imageRoot, target === "." ? path.basename(source) : target);
          // Keep pnpm's relative links relocatable; the filter also keeps copied
          // executable fixture files on libuv's close-on-exec copy path.
          fs.cpSync(sourcePath, destination, {
            recursive: true,
            verbatimSymlinks: true,
            filter: () => true,
          });
        }
        return imageRoot;
      };
      const legacyImage = project(false);
      const image = project(true);
      expect(() =>
        assertArtifactTreeReadable(path.join(image, "node_modules"), {
          allowLinksWithin: image,
          readFiles: true,
        }),
      ).not.toThrow();
      for (const alias of [
        "node_modules/.pnpm/node_modules/openclaw-control-ui",
        "node_modules/.pnpm/node_modules/@openclaw/omitted",
        "node_modules/ui-alias",
        "packages/gateway-protocol/node_modules/dev-ui",
        "extensions/workboard/node_modules/dev-ui",
        "node_modules/.pnpm/plugin-only@1.0.0/node_modules/plugin-only/node_modules/dev-ui",
      ]) {
        expect(fs.lstatSync(path.join(image, alias), { throwIfNoEntry: false })).toBeUndefined();
      }
      expect(
        fs.realpathSync(
          path.join(image, "node_modules/.pnpm/node_modules/@openclaw/gateway-protocol"),
        ),
      ).toBe(path.join(image, "packages/gateway-protocol"));
      for (const pluginPath of ["extensions/workboard", "dist/extensions/workboard"]) {
        const legacyRequire = createRequire(path.join(legacyImage, pluginPath, "package.json"));
        expect(() => legacyRequire("./index.cjs")).toThrow(/Cannot find module/u);
        const pluginRequire = createRequire(path.join(image, pluginPath, "package.json"));
        expect(pluginRequire("./index.cjs")).toEqual({
          protocol: "typebox",
          contract: "typebox",
          ordinary: "plugin-only",
        });
        const workspaceExports = [
          ["@openclaw/gateway-protocol", "packages/gateway-protocol/dist/index.cjs"],
          ["@openclaw/workboard-contract", "packages/workboard-contract/src/index.cjs"],
        ] as const;
        for (const [name, owner] of workspaceExports) {
          expect(pluginRequire.resolve(name)).toBe(path.join(image, owner));
        }
      }
      const siblingRequire = createRequire(path.join(image, "extensions/sibling/package.json"));
      expect(siblingRequire("sibling-only")).toBe("sibling-only");
      expect(fs.existsSync(path.join(image, "extensions/omitted"))).toBe(false);
      expect(fs.existsSync(path.join(image, "dist/extensions/omitted"))).toBe(false);
      expect(
        fs.existsSync(path.join(image, "packages/gateway-protocol/node_modules/dev-only")),
      ).toBe(false);
    },
  );

  it.each(["packages", "plugins"])(
    "refuses to traverse a symlinked %s workspace root during alias cleanup",
    (workspaceDir) => {
      const repoRoot = fs.realpathSync(makeRepoRoot("openclaw-docker-workspace-root-link-"));
      const externalRoot = fs.realpathSync(makeRepoRoot("openclaw-docker-external-workspace-"));
      writeJsonFile(path.join(repoRoot, "package.json"), { files: ["dist/**"] });
      const uiDir = path.join(repoRoot, "ui");
      writeJsonFile(path.join(uiDir, "package.json"), { name: "openclaw-control-ui" });
      const externalPackage = path.join(externalRoot, "fixture");
      writeJsonFile(path.join(externalPackage, "package.json"), { name: "external-fixture" });
      const alias = path.join(externalPackage, "node_modules", "build-ui");
      fs.mkdirSync(path.dirname(alias), { recursive: true });
      fs.symlinkSync(uiDir, alias, "dir");
      fs.symlinkSync(externalRoot, path.join(repoRoot, workspaceDir), "dir");

      expect(() =>
        pruneDockerPluginDist({ repoRoot, env: { OPENCLAW_BUNDLED_PLUGIN_DIR: "plugins" } }),
      ).toThrow(/symbolic link/u);
      expect(fs.readlinkSync(alias)).toBe(uiDir);
      expect(fs.readFileSync(path.join(externalPackage, "package.json"), "utf8")).toContain(
        "external-fixture",
      );
    },
  );

  it("refuses to discard a required broken alias into an excluded workspace", () => {
    const repoRoot = fs.realpathSync(makeRepoRoot("openclaw-docker-missing-excluded-required-"));
    writeJsonFile(path.join(repoRoot, "package.json"), {
      dependencies: { needed: "workspace:*" },
    });
    fs.mkdirSync(path.join(repoRoot, "node_modules"));
    fs.mkdirSync(path.join(repoRoot, "ui"));
    const link = path.join(repoRoot, "node_modules", "needed");
    const target = path.relative(path.dirname(link), path.join(repoRoot, "ui", "missing"));
    fs.symlinkSync(target, link, "dir");

    expect(() => pruneDockerPluginDist({ repoRoot, env: {} })).toThrow(
      "Docker required dependency is missing from excluded workspace: node_modules/needed",
    );
    expect(fs.readlinkSync(link)).toBe(target);
  });

  it("preserves every alias in a required broken chain into an excluded workspace", () => {
    const repoRoot = fs.realpathSync(makeRepoRoot("openclaw-docker-required-alias-chain-"));
    writeJsonFile(path.join(repoRoot, "package.json"), {
      dependencies: { needed: "workspace:*" },
    });
    const needed = path.join(repoRoot, "node_modules/needed");
    const alias = path.join(repoRoot, "node_modules/.pnpm/node_modules/ui-alias");
    const target = path.join(repoRoot, "ui", "missing");
    fs.mkdirSync(path.dirname(alias), { recursive: true });
    fs.mkdirSync(path.dirname(target));
    const neededTarget = path.relative(path.dirname(needed), alias);
    const aliasTarget = path.relative(path.dirname(alias), target);
    fs.symlinkSync(neededTarget, needed, "dir");
    fs.symlinkSync(aliasTarget, alias, "dir");

    expect(() => pruneDockerPluginDist({ repoRoot, env: {} })).toThrow(
      "Docker required dependency is missing from excluded workspace: node_modules/.pnpm/node_modules/ui-alias",
    );
    expect(fs.readlinkSync(needed)).toBe(neededTarget);
    expect(fs.readlinkSync(alias)).toBe(aliasTarget);
    expect(fs.existsSync(target)).toBe(false);
  });

  it.each(["cycle", "overlong"])(
    "refuses a required %s symlink chain before mutating aliases",
    (kind) => {
      const repoRoot = fs.realpathSync(makeRepoRoot("openclaw-docker-required-chain-budget-"));
      writeJsonFile(path.join(repoRoot, "package.json"), {
        dependencies: { needed: "workspace:*" },
      });
      const modules = path.join(repoRoot, "node_modules");
      fs.mkdirSync(modules);
      const names = [
        "needed",
        ...Array.from({ length: kind === "cycle" ? 1 : 40 }, (_, i) => `alias-${i}`),
      ];
      for (const [index, name] of names.entries()) {
        const target = names[index + 1] ?? (kind === "cycle" ? "needed" : "missing");
        fs.symlinkSync(target, path.join(modules, name), "dir");
      }

      expect(() => pruneDockerPluginDist({ repoRoot, env: {} })).toThrow(
        kind === "cycle" ? /symlink cycle/u : /exceeds 40 symlink hops/u,
      );
      expect(fs.readlinkSync(path.join(modules, "needed"))).toBe("alias-0");
      expect(fs.lstatSync(path.join(modules, names[names.length - 1]!)).isSymbolicLink()).toBe(
        true,
      );
    },
  );

  it("can discard an already-missing optional alias into an excluded workspace", () => {
    const repoRoot = fs.realpathSync(makeRepoRoot("openclaw-docker-missing-excluded-optional-"));
    writeJsonFile(path.join(repoRoot, "package.json"), {
      optionalDependencies: { unneeded: "workspace:*" },
    });
    fs.mkdirSync(path.join(repoRoot, "node_modules"));
    fs.mkdirSync(path.join(repoRoot, "ui"));
    const link = path.join(repoRoot, "node_modules", "unneeded");
    fs.symlinkSync(path.join(repoRoot, "ui", "missing"), link, "dir");

    expect(pruneDockerPluginDist({ repoRoot, env: {} })).toContain("node_modules/unneeded");
    expect(fs.lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
  });

  it.each(["ui", "extensions/omitted"])(
    "refuses to exclude workspace %s required by retained runtime code",
    (excludedRoot) => {
      const repoRoot = fs.realpathSync(makeRepoRoot("openclaw-docker-excluded-dependency-"));
      const packageDir = path.join(repoRoot, excludedRoot);
      writeJsonFile(path.join(repoRoot, "package.json"), {
        files: ["dist/**", "!dist/extensions/omitted/**"],
        dependencies: { "required-workspace": "workspace:*" },
      });
      writeJsonFile(path.join(packageDir, "package.json"), { name: "required-workspace" });
      const link = path.join(repoRoot, "node_modules", "required-workspace");
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(path.relative(path.dirname(link), packageDir), link, "dir");

      expect(() => pruneDockerPluginDist({ repoRoot, env: {} })).toThrow(
        `Docker runtime dependency resolves to excluded workspace: ${excludedRoot}`,
      );
      expect(fs.realpathSync(link)).toBe(packageDir);
      expect(fs.existsSync(path.join(packageDir, "package.json"))).toBe(true);
    },
  );

  it("does not discard a missing required dependency as an excluded workspace alias", () => {
    const repoRoot = fs.realpathSync(makeRepoRoot("openclaw-docker-broken-required-link-"));
    writeJsonFile(path.join(repoRoot, "package.json"), {
      files: ["dist/**", "!dist/extensions/kept/**"],
    });
    const pluginDir = path.join(repoRoot, "extensions/kept");
    writeJsonFile(path.join(pluginDir, "package.json"), {
      name: "@openclaw/kept",
      dependencies: { "required-missing": "1.0.0" },
    });
    writeDistPluginFile(repoRoot, "dist", "kept");
    const link = path.join(pluginDir, "node_modules/required-missing");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(path.join(repoRoot, "node_modules/missing-payload"), link, "dir");

    expect(() => pruneDockerPluginDist({ repoRoot, env: { OPENCLAW_EXTENSIONS: "kept" } })).toThrow(
      /ENOENT/u,
    );
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("fails closed when a retained plugin dependency stays unreachable from its packaged root", () => {
    const repoRoot = makeRepoRoot("openclaw-docker-plugin-dist-unreachable-");
    writeJsonFile(path.join(repoRoot, "package.json"), {
      files: ["dist/**", "!dist/extensions/kept-external/**"],
    });
    writeDistPluginFile(repoRoot, "dist", "kept-external");
    writeJsonFile(path.join(repoRoot, "extensions", "kept-external", "package.json"), {
      name: "@openclaw/kept-external",
      version: "0.0.0",
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
    const repoRoot = makeRepoRoot("openclaw-docker-plugin-workspace-importer-");
    writeJsonFile(path.join(repoRoot, "package.json"), {
      files: ["dist/**", "!dist/extensions/omitted-client/**"],
      dependencies: {
        "shared-client": "1.0.0",
      },
    });
    const keptPluginDir = path.join(repoRoot, "extensions", "kept-client");
    writeJsonFile(path.join(keptPluginDir, "package.json"), {
      name: "@openclaw/kept-client",
      version: "0.0.0",
      dependencies: {
        "shared-client": "2.0.0",
      },
    });
    writeJsonFile(path.join(repoRoot, "extensions", "omitted-client", "package.json"), {
      name: "@openclaw/omitted-client",
      version: "0.0.0",
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
    fs.writeFileSync(
      path.join(keptPluginDir, "index.js"),
      'module.exports = require("shared-client");\n',
    );
    fs.writeFileSync(
      path.join(keptPluginDir, "node_modules", "shared-client", "index.js"),
      'module.exports = require("kept-transitive");\n',
    );
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
    const repoRoot = makeRepoRoot("openclaw-docker-plugin-nested-dependencies-");
    writeJsonFile(path.join(repoRoot, "package.json"), {
      files: ["dist/**", "!dist/extensions/optional-client/**"],
      dependencies: {
        grammy: "1.45.1",
        "modern-client": "1.0.0",
      },
    });
    writeJsonFile(path.join(repoRoot, "extensions", "optional-client", "package.json"), {
      name: "@openclaw/optional-client",
      version: "0.0.0",
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
    fs.writeFileSync(path.join(grammyDir, "index.js"), 'module.exports = require("node-fetch");\n');
    fs.writeFileSync(
      path.join(grammyDir, "node_modules", "node-fetch", "index.js"),
      'module.exports = require("whatwg-url");\n',
    );
    fs.writeFileSync(
      path.join(grammyDir, "node_modules", "whatwg-url", "index.js"),
      'module.exports = require("tr46");\n',
    );
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
