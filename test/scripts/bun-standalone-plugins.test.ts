import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planStandalonePackageManager } from "../../scripts/lib/bun-standalone-package-manager.mjs";
import {
  classifyStandalonePlugins,
  planStandalonePlugins,
  pruneStandalonePluginDirectories,
  selectStandalonePluginModules,
} from "../../scripts/lib/bun-standalone-plugins.mjs";
import {
  planStandaloneRuntime,
  pruneStandaloneRuntime,
} from "../../scripts/lib/bun-standalone-sidecar.mjs";
import { collectRootPackageExcludedExtensionDirs } from "../../scripts/lib/root-package-bundled-plugin-excludes.mjs";
import { listBundledPluginMetadata } from "../../src/plugins/bundled-plugin-metadata.js";
import {
  listOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
} from "../../src/plugins/official-external-plugin-catalog.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-plugins-"));
  temporary.push(root);
  const write = (name: string, contents: string) => {
    const filename = path.join(root, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents);
  };
  const plugin = (id: string, requiresPlugins: string[] = [], dirName = id) => {
    for (const parent of ["dist/extensions", "extensions"]) {
      write(
        `${parent}/${dirName}/openclaw.plugin.json`,
        JSON.stringify({ id, configSchema: {}, requiresPlugins }),
      );
      write(
        `${parent}/${dirName}/package.json`,
        JSON.stringify({ name: `@openclaw/${id}`, openclaw: { extensions: ["./index.js"] } }),
      );
      write(`${parent}/${dirName}/index.js`, `export const id = ${JSON.stringify(id)};`);
      write(`${parent}/${dirName}/assets/browser.js`, "browser asset");
    }
  };
  write(
    "package.json",
    JSON.stringify({ type: "module", files: ["dist", "!dist/extensions/codex/**"] }),
  );
  plugin("core");
  plugin("codex");
  plugin("matrix");
  return { root, write, plugin };
}

describe("standalone plugin selection", () => {
  it("defaults to the complete built inventory, and rejects unknown or un-installable omissions", () => {
    const { root, plugin } = fixture();
    plugin("qa-channel");
    plugin("crabbox");
    expect(classifyStandalonePlugins(root)).toEqual([
      { id: "codex", dirName: "codex", hasInstallRoute: true, devOnly: false, requiresPlugins: [] },
      { id: "core", dirName: "core", hasInstallRoute: false, devOnly: false, requiresPlugins: [] },
      {
        id: "crabbox",
        dirName: "crabbox",
        hasInstallRoute: false,
        devOnly: false,
        requiresPlugins: [],
      },
      {
        id: "matrix",
        dirName: "matrix",
        hasInstallRoute: true,
        devOnly: false,
        requiresPlugins: [],
      },
      {
        id: "qa-channel",
        dirName: "qa-channel",
        hasInstallRoute: false,
        devOnly: true,
        requiresPlugins: [],
      },
    ]);
    expect(planStandalonePlugins(root)).toMatchObject({
      embedded: ["codex", "core", "crabbox", "matrix", "qa-channel"],
      omitted: [],
    });
    expect(() => planStandalonePlugins(root, ["core", "missing"])).toThrow(
      "Unknown bundled plugin ID(s): missing",
    );
    expect(() => planStandalonePlugins(root, ["codex"])).toThrow(
      "Cannot omit bundled plugin core: no official-external",
    );
    expect(() => planStandalonePlugins(root, ["core", "codex"])).toThrow(
      "Cannot omit bundled plugin crabbox",
    );
    expect(planStandalonePlugins(root, ["core", "codex", "crabbox"])).toMatchObject({
      embedded: ["codex", "core", "crabbox"],
      omitted: ["matrix", "qa-channel"],
    });
  });

  it("uses manifest identities and requires a closed plugin dependency set", () => {
    const { root, plugin } = fixture();
    plugin("diffs");
    plugin("diffs-language-pack", ["diffs"]);
    plugin("kimi", [], "kimi-coding");
    expect(classifyStandalonePlugins(root).find((entry) => entry.id === "kimi")).toMatchObject({
      dirName: "kimi-coding",
    });
    expect(
      classifyStandalonePlugins(root).find((entry) => entry.id === "diffs-language-pack")
        ?.requiresPlugins,
    ).toEqual(["diffs"]);
    expect(() => planStandalonePlugins(root, ["core", "kimi", "diffs-language-pack"])).toThrow(
      "diffs-language-pack requires plugin diffs",
    );
    expect(
      planStandalonePlugins(root, ["core", "kimi", "diffs", "diffs-language-pack"]).omitted,
    ).toEqual(["codex", "matrix"]);
    expect(() => planStandalonePlugins(root, ["core", "kimi-coding"])).toThrow(
      "Unknown bundled plugin ID(s): kimi-coding",
    );
  });

  it("removes omitted discovery metadata and assets while preserving official installation offers", () => {
    const { root, write, plugin } = fixture();
    plugin("cloudflare");
    write(
      "dist/cli-startup-metadata.json",
      JSON.stringify({ rootHelpText: "full build cached help" }),
    );
    const catalog = { entries: listOfficialExternalPluginCatalogEntries() };
    write("dist/channel-catalog.json", JSON.stringify(catalog));
    const selection = planStandalonePlugins(root, ["core", "codex"]);
    pruneStandalonePluginDirectories(root, selection);
    const bundled = listBundledPluginMetadata({
      rootDir: root,
      scanDir: path.join(root, "dist/extensions"),
      includeChannelConfigs: false,
    });
    expect(bundled.map((entry) => entry.manifest.id)).toEqual(["codex", "core"]);
    for (const id of ["cloudflare", "matrix"]) {
      for (const parent of ["dist/extensions", "extensions"]) {
        expect(fs.existsSync(path.join(root, parent, id))).toBe(false);
      }
    }
    expect(fs.existsSync(path.join(root, "dist/extensions/codex/assets/browser.js"))).toBe(true);
    expect(fs.existsSync(path.join(root, "dist/cli-startup-metadata.json"))).toBe(false);
    expect([...collectRootPackageExcludedExtensionDirs({ cwd: root })]).toEqual([
      "cloudflare",
      "matrix",
    ]);
    const retainedCatalog = JSON.parse(
      fs.readFileSync(path.join(root, "dist/channel-catalog.json"), "utf8"),
    );
    for (const id of ["cloudflare", "matrix"]) {
      const entry = retainedCatalog.entries.find(
        (candidate: Parameters<typeof resolveOfficialExternalPluginId>[0]) =>
          resolveOfficialExternalPluginId(candidate) === id,
      );
      expect(resolveOfficialExternalPluginInstall(entry)?.npmSpec).toBe(`@openclaw/${id}`);
    }
  });

  it("preserves the package manager runtime closure when plugins are omitted", () => {
    const { root, write } = fixture();
    write("node_modules/npm/package.json", JSON.stringify({ name: "npm", version: "1.0.0" }));
    write("node_modules/npm/LICENSE", "fixture license");
    write("node_modules/npm/bin/npm-cli.js", 'require("../lib/cli.js");');
    write("node_modules/npm/lib/cli.js", 'module.exports = require("install-helper");');
    write(
      "node_modules/npm/node_modules/install-helper/package.json",
      JSON.stringify({ name: "install-helper", main: "index.js" }),
    );
    write("node_modules/npm/node_modules/install-helper/index.js", "module.exports = 42;");

    pruneStandalonePluginDirectories(root, planStandalonePlugins(root, ["core", "codex"]));
    const manager = planStandalonePackageManager(root);
    const runtime = planStandaloneRuntime(root, manager.files);
    expect(runtime.pruning.categories.packageManager).toMatchObject({ files: 6 });
    pruneStandaloneRuntime(runtime);

    expect(fs.existsSync(path.join(root, "dist/extensions/matrix"))).toBe(false);
    expect(fs.readFileSync(path.join(root, manager.manifest.entrypoint), "utf8")).toBe(
      'require("../lib/cli.js");',
    );
    expect(
      fs.readFileSync(path.join(root, "npm/node_modules/install-helper/index.js"), "utf8"),
    ).toBe("module.exports = 42;");
  });

  it("excludes private root chunks before compilation but retains shared and currently referenced chunks", async () => {
    const { root, write } = fixture();
    const sources = {
      "private.js": 'import "./private-child.js"; export const privatePlugin = true;',
      "private-child.js": "export const child = true;",
      "shared.js": "export const shared = true;",
      "rescued.js": "export const rescued = true;",
      "entry.js": 'import "./rescued.js"; export const core = true;',
    };
    const chunks = Object.fromEntries(
      Object.entries(sources)
        .filter(([name]) => name !== "entry.js")
        .map(([name, source]) => [
          name,
          {
            sha256: createHash("sha256").update(source).digest("hex"),
            extensions: name === "shared.js" ? ["matrix", "codex"] : ["matrix"],
          },
        ]),
    );
    for (const [name, source] of Object.entries(sources)) {
      write(`dist/${name}`, source);
    }
    write("dist/runtime-dependency-ownership.json", JSON.stringify({ chunks }));
    const selection = planStandalonePlugins(root, ["core", "codex"]);
    pruneStandalonePluginDirectories(root, selection);
    const entries = Object.keys(sources).map((name) => `dist/${name}`);
    expect(await selectStandalonePluginModules(root, entries, selection)).toEqual([
      "dist/shared.js",
      "dist/rescued.js",
      "dist/entry.js",
    ]);
    write("dist/private.js", "stale ownership bytes");
    await expect(selectStandalonePluginModules(root, entries, selection)).rejects.toThrow(
      "ownership does not match dist/private.js",
    );
  });
});
