import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  planStandaloneRuntime,
  pruneStandaloneRuntime,
  standaloneResourceCategory,
} from "../../scripts/lib/bun-standalone-sidecar.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function fixture(files: string[]) {
  const root = tempDirs.make("standalone-sidecar-");
  const runtime = path.join(root, "runtime");
  for (const name of files) {
    const filename = path.join(runtime, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, "fixture\n");
  }
  return runtime;
}

describe("standalone resource allowlist", () => {
  it.each([
    ["docs/reference/templates/BOOT.md", "templates"],
    ["docs/reference/templates/roles/presets/team.json", "templates"],
    ["docs/reference/templates/roles/coordinator/workspace/AGENTS.md", "templates"],
    ["docs/gateway/configuration.md", "docs"],
    ["docs/docs.json", "docs"],
    ["docs/internal/runbook.md", undefined],
    ["docs/AGENTS.md", undefined],
    ["docs/CLAUDE.md", undefined],
    ["skills/example/run.py", "skills"],
    ["custodian-skills/recover/SKILL.md", "skills"],
    ["dist/control-ui/assets/index.js", "controlUi"],
    ["dist/assets/session-card/Lato-Regular.ttf", "runtimeAssets"],
    ["dist/export-html/template.js", "templates"],
    ["dist/bundled/session-memory/HOOK.md", "hookMetadata"],
    ["dist/bundled/session-memory/handler.js", undefined],
    ["dist/extensions/diffs/assets/viewer-runtime.js", "pluginAssets"],
    ["dist/extensions/example/dist/control-ui/index.js", "pluginAssets"],
    ["dist/extensions/browser/chrome-extension/manifest.json", "pluginAssets"],
    ["dist/extensions/tlon/bundled-skills/tlon/examples/main.hoon", "pluginAssets"],
    ["dist/extensions/workboard/workboard-schema.postgres.sql", "pluginAssets"],
    ["dist/extensions/example/openclaw.plugin.json", "pluginMetadata"],
    ["extensions/example/package.json", "pluginMetadata"],
    ["dist/cli-startup-metadata.json", "runtimeMetadata"],
    ["dist/.source-module-urls/build.json", undefined],
    ["dist/extensions/example/.source-module-urls/build.json", undefined],
    ["extensions/example/dist/.source-module-urls/build.json", undefined],
    ["dist/tree-sitter-bash.wasm", "runtimeAssets"],
    ["LICENSE", "licenses"],
    ["THIRD_PARTY_NOTICES.md", "licenses"],
    ["dist/gateway.js", undefined],
    ["dist/extensions/example/index.js", undefined],
    ["extensions/example/index.ts", undefined],
    ["node_modules/test/index.js", undefined],
    ["dist/control-ui/assets/index.js.map", undefined],
    ["dist/plugin-sdk/index.d.ts", undefined],
    ["docs/assets/screenshot.png", undefined],
  ])("assigns the disk owner of %s", (filename, category) => {
    expect(standaloneResourceCategory(filename)).toBe(category);
  });

  it("keeps declared non-JavaScript resources while embedding host child scripts", () => {
    const resources = new Set([
      "dist/extensions/example/helpers/export.py",
      "dist/extensions/example/resolver.js",
    ]);
    expect(standaloneResourceCategory("dist/extensions/example/helpers/export.py", resources)).toBe(
      "pluginAssets",
    );
    expect(
      standaloneResourceCategory("dist/extensions/example/resolver.js", resources),
    ).toBeUndefined();
    expect(
      standaloneResourceCategory("dist/extensions/example/helpers/unlisted.py", resources),
    ).toBeUndefined();
  });

  it("ships resources once with no executable modules, dependency farm, or symlinks", () => {
    const runtime = fixture([
      "package.json",
      "dist/build-info.json",
      "dist/entry.js",
      "dist/entry.js.map",
      "dist/extensions/example/index.js",
      "dist/extensions/example/package.json",
      "dist/control-ui/index.html",
      "dist/control-ui/assets/index.js",
      "docs/docs.json",
      "docs/cli/start.md",
      "skills/example/SKILL.md",
      "node_modules/.pnpm/native@1/node_modules/native/addon.node",
      "node_modules/.pnpm/native@1/node_modules/native/index.js",
    ]);
    fs.symlinkSync(".pnpm/native@1/node_modules/native", path.join(runtime, "node_modules/native"));
    const plan = planStandaloneRuntime(runtime, [
      {
        source: "node_modules/native/addon.node",
        destination: "native/native@1/addon.node",
        category: "nativeAddons",
      },
    ]);
    expect(fs.existsSync(path.join(runtime, "node_modules"))).toBe(true);
    expect(fs.existsSync(path.join(runtime, "dist/entry.js"))).toBe(true);
    const result = pruneStandaloneRuntime(plan);
    expect(fs.existsSync(path.join(runtime, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(runtime, "dist/entry.js"))).toBe(false);
    expect(fs.existsSync(path.join(runtime, "dist/extensions/example/index.js"))).toBe(false);
    expect(fs.readFileSync(path.join(runtime, "native/native@1/addon.node"), "utf8")).toBe(
      "fixture\n",
    );
    expect(fs.lstatSync(path.join(runtime, "native/native@1/addon.node")).isSymbolicLink()).toBe(
      false,
    );
    expect(result).toMatchObject({
      policy: "runtime-resources-v1",
      removedFiles: 4,
      removedBytes: 32,
      removedSymlinks: 1,
      sidecarPlugins: [],
      categories: {
        runtimeMetadata: { files: 2, bytes: 16 },
        pluginMetadata: { files: 1, bytes: 8 },
        controlUi: { files: 2, bytes: 16 },
        docs: { files: 2, bytes: 16 },
        skills: { files: 1, bytes: 8 },
        nativeAddons: { files: 1, bytes: 8 },
      },
    });
    expect(Object.values(result.categories).reduce((sum, entry) => sum + entry.files, 0)).toBe(9);
  });

  it("rejects resource links outside the snapshot before replacing it", () => {
    const runtime = fixture(["package.json"]);
    fs.writeFileSync(path.join(path.dirname(runtime), "outside.node"), "outside");
    fs.symlinkSync("../outside.node", path.join(runtime, "addon.node"));
    expect(() =>
      planStandaloneRuntime(runtime, [
        { source: "addon.node", destination: "native/addon.node", category: "nativeAddons" },
      ]),
    ).toThrow("contained regular file");
    expect(fs.existsSync(path.join(runtime, "package.json"))).toBe(true);
  });

  it("preserves image metadata directories without their embedded files", () => {
    const runtime = fixture([
      "package.json",
      "dist/plugin-sdk/index.js",
      "dist/state/openclaw-state.worker.js",
      "extensions/example/index.ts",
      "packages/gateway-client/dist/index.mjs",
    ]);
    const directories = [
      "dist/plugin-sdk",
      "dist/state",
      "extensions/example",
      "packages/gateway-client/dist",
    ];
    const result = pruneStandaloneRuntime(
      planStandaloneRuntime(runtime, [], new Set(), directories),
    );
    for (const directory of directories) {
      const filename = path.join(runtime, directory);
      expect(fs.realpathSync(filename)).toBe(path.join(fs.realpathSync(runtime), directory));
      expect(fs.lstatSync(filename).isDirectory()).toBe(true);
      expect(fs.readdirSync(filename)).toEqual([]);
    }
    expect(result.categories).toEqual({ runtimeMetadata: { files: 1, bytes: 8 } });
    expect(fs.existsSync(path.join(runtime, "node_modules"))).toBe(false);
  });

  it("preserves empty resolution directories without scripts or dependency contents", () => {
    const runtime = fixture([
      "package.json",
      "scripts/windows-cmd-helpers.mjs",
      "dist/extensions/node_modules/openclaw/package.json",
      "dist/extensions/node_modules/openclaw/index.js",
    ]);
    const result = pruneStandaloneRuntime(planStandaloneRuntime(runtime));
    for (const directory of ["scripts", "dist/extensions/node_modules"]) {
      const filename = path.join(runtime, directory);
      expect(fs.lstatSync(filename).isDirectory()).toBe(true);
      expect(fs.readdirSync(filename)).toEqual([]);
    }
    expect(result.categories).toEqual({ runtimeMetadata: { files: 1, bytes: 8 } });
    expect(result.removedFiles).toBe(3);
    expect(result.removedSymlinks).toBe(0);
  });

  it("does not create resolution directories absent from the build snapshot", () => {
    const runtime = fixture(["package.json"]);
    pruneStandaloneRuntime(planStandaloneRuntime(runtime));
    expect(fs.existsSync(path.join(runtime, "scripts"))).toBe(false);
    expect(fs.existsSync(path.join(runtime, "dist/extensions/node_modules"))).toBe(false);
  });

  it.each([
    "node_modules/.pnpm/example",
    "dist/../outside",
    "dist/node_modules/example",
    "packages/gateway-client/node_modules/example",
  ])("rejects metadata directory %s", (directory) => {
    const runtime = fixture(["package.json"]);
    expect(() => planStandaloneRuntime(runtime, [], new Set(), [directory])).toThrow(
      "Invalid standalone metadata directory",
    );
    expect(fs.existsSync(path.join(runtime, "package.json"))).toBe(true);
  });

  it("rejects traversal in resource destinations", () => {
    const runtime = fixture(["package.json"]);
    expect(() =>
      planStandaloneRuntime(runtime, [
        { source: "package.json", destination: "../outside", category: "nativeAddons" },
      ]),
    ).toThrow("Invalid standalone resource path");
  });
});
