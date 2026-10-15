import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetGlobalHookRunner } from "./hook-runner-global.js";
import {
  installPluginFromPath,
  PLUGIN_INSTALL_ERROR_CODE,
  resolvePluginInstallDir,
} from "./install.js";
import { createSyncSuiteTempRootTracker } from "./test-helpers/fs-fixtures.js";

const suiteTempRootTracker = createSyncSuiteTempRootTracker("openclaw-plugin-install-entries");
const pluginId = "entry-plugin";
afterAll(() => suiteTempRootTracker.cleanup());
beforeEach(() => resetGlobalHookRunner());

type PackageInstallShapeCase = {
  title: string;
  openclaw: Record<string, unknown>;
  files?: Readonly<Record<string, string>>;
  options?: Pick<
    Parameters<typeof installPluginFromPath>[0],
    "dryRun" | "allowSourceTypeScriptEntries"
  >;
  ok: boolean;
  errorIncludes?: readonly string[];
  expectTarget?: boolean;
};

function setupPackageInstallShape(params: PackageInstallShapeCase) {
  const root = suiteTempRootTracker.makeTempDir();
  const fixture = {
    pluginDir: path.join(root, "plugin-src"),
    extensionsDir: path.join(root, "extensions"),
  };
  fs.mkdirSync(fixture.pluginDir);
  fs.mkdirSync(fixture.extensionsDir);
  fs.writeFileSync(
    path.join(fixture.pluginDir, "package.json"),
    JSON.stringify({ name: pluginId, version: "1.0.0", openclaw: params.openclaw }),
  );
  for (const [relativePath, contents] of Object.entries(params.files ?? {})) {
    const filePath = path.join(fixture.pluginDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }
  return fixture;
}

describe("package install entries", () => {
  it.each<PackageInstallShapeCase>([
    {
      title: "rejects package installs when openclaw.extensions entries escape the package",
      openclaw: { extensions: ["../src/index.ts"], runtimeExtensions: ["./dist/index.js"] },
      files: { "dist/index.js": "export {};\n" },
      ok: false,
      errorIncludes: ["extension entry escapes plugin directory"],
    },
    {
      title: "rejects package installs when no extension runtime entry exists",
      openclaw: { extensions: ["./dist/index.js"] },
      ok: false,
      errorIncludes: ["extension entry not found"],
    },
    {
      title: "allows missing TypeScript source entries when an inferred built runtime entry exists",
      openclaw: { extensions: ["./src/index.ts"] },
      files: { "dist/index.js": "export {};\n" },
      ok: true,
    },
    {
      title: "rejects package installs when openclaw.extensions contains a blank entry",
      openclaw: { extensions: ["./dist/index.js", " "] },
      files: { "dist/index.js": "export {};\n" },
      ok: false,
      errorIncludes: ["openclaw.extensions[1]", "non-empty string"],
    },
    {
      title:
        "rejects package installs when a TypeScript extension entry has no compiled runtime output",
      openclaw: { extensions: ["./src/index.ts"] },
      files: { "src/index.ts": "export {};\n" },
      ok: false,
      errorIncludes: [
        "requires compiled runtime output",
        "./dist/index.js",
        "plugin packaging issue",
        "retry installation after the publisher ships compiled JavaScript",
      ],
    },
    {
      title:
        "allows linked source probes when TypeScript extension entries have no compiled runtime output",
      openclaw: { extensions: ["./src/index.ts"] },
      files: { "src/index.ts": "export {};\n" },
      options: { dryRun: true, allowSourceTypeScriptEntries: true },
      ok: true,
      expectTarget: true,
    },
    {
      title: "rejects package installs when runtimeExtensions length does not match extensions",
      openclaw: {
        extensions: ["./src/one.ts", "./src/two.ts"],
        runtimeExtensions: ["./dist/one.js"],
      },
      files: { "dist/one.js": "export {};\n" },
      ok: false,
      errorIncludes: ["runtimeExtensions length (1)", "extensions length (2)"],
    },
    {
      title: "rejects package installs when runtimeExtensions contains a blank entry",
      openclaw: { extensions: ["./src/index.ts"], runtimeExtensions: [" "] },
      files: { "src/index.ts": "export {};\n", "dist/index.js": "export {};\n" },
      ok: false,
      errorIncludes: ["openclaw.runtimeExtensions[0]", "non-empty string"],
    },
    {
      title: "rejects package installs when runtimeSetupEntry is missing",
      openclaw: {
        extensions: ["./dist/index.js"],
        setupEntry: "./src/setup-entry.ts",
        runtimeSetupEntry: "./dist/setup-entry.js",
      },
      files: { "dist/index.js": "export {};\n", "src/setup-entry.ts": "export {};\n" },
      ok: false,
      errorIncludes: ["runtime setup entry not found", "./dist/setup-entry.js"],
    },
  ])("$title", async (scenario) => {
    const { pluginDir, extensionsDir } = setupPackageInstallShape(scenario);
    const result = await installPluginFromPath({
      path: pluginDir,
      extensionsDir,
      ...scenario.options,
    });

    expect(result.ok).toBe(scenario.ok);
    if (result.ok) {
      expect(result.pluginId).toBe(pluginId);
      if (scenario.expectTarget) {
        expect(result.targetDir).toBe(resolvePluginInstallDir(result.pluginId, extensionsDir));
      }
      return;
    }
    expect(result.code).toBe(PLUGIN_INSTALL_ERROR_CODE.INVALID_OPENCLAW_EXTENSIONS);
    expect(fs.existsSync(resolvePluginInstallDir(pluginId, extensionsDir))).toBe(false);
    expect(result.error).not.toContain("disable/uninstall");
    for (const fragment of scenario.errorIncludes ?? []) {
      expect(result.error).toContain(fragment);
    }
  });

  it.each<PackageInstallShapeCase>([
    {
      title:
        "allows runtime extension entry files in hidden directories without built-in scanner warnings",
      openclaw: { extensions: ["index.js"], runtimeExtensions: [".hidden/runtime.cjs"] },
      files: {
        "index.js": "module.exports = {};\n",
        ".hidden/runtime.cjs":
          'const { execFileSync } = require("child_process");\nexecFileSync(process.execPath, ["-e", ""]);',
      },
      ok: true,
    },
    {
      title:
        "allows runtime setup entry files in hidden directories without built-in scanner warnings",
      openclaw: {
        extensions: ["index.js"],
        setupEntry: "setup.ts",
        runtimeSetupEntry: ".hidden/setup.cjs",
      },
      files: {
        "index.js": "module.exports = {};\n",
        "setup.ts": "export {};\n",
        ".hidden/setup.cjs":
          'const { execFileSync } = require("child_process");\nexecFileSync(process.execPath, ["-e", ""]);',
      },
      ok: true,
    },
    {
      title:
        "allows inferred runtime entry files in hidden directories without built-in scanner warnings",
      openclaw: { extensions: [".hidden/index.ts"] },
      files: {
        ".hidden/index.ts": "export {};\n",
        ".hidden/index.js":
          'const { execFileSync } = require("child_process");\nexecFileSync(process.execPath, ["-e", ""]);',
      },
      ok: true,
    },
  ])("$title", async (scenario) => {
    const { pluginDir, extensionsDir } = setupPackageInstallShape(scenario);
    const warnings: string[] = [];
    const result = await installPluginFromPath({
      path: pluginDir,
      extensionsDir,
      logger: { warn: (message) => warnings.push(message) },
    });

    expect(result.ok).toBe(true);
    expect(warnings).toStrictEqual([]);
  });
});
