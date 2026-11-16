import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, expect, it } from "vitest";
import { resetGlobalHookRunner } from "./hook-runner-global.js";
import {
  installPluginFromPath,
  PLUGIN_INSTALL_ERROR_CODE,
  resolvePluginInstallDir,
} from "./install.js";
import { createSyncSuiteTempRootTracker } from "./test-helpers/fs-fixtures.js";

const temps = createSyncSuiteTempRootTracker("openclaw-plugin-install-entries");
const pluginId = "entry-plugin";
const moduleSource = "export {};\n";
const sourceEntry = "./src/index.ts";
const runtimeEntry = "./dist/index.js";
afterAll(() => temps.cleanup());
beforeEach(() => resetGlobalHookRunner());

function packageFixture(openclaw: Record<string, unknown>, files: Record<string, string>) {
  const root = temps.makeTempDir();
  const pluginDir = path.join(root, "plugin-src");
  const extensionsDir = path.join(root, "extensions");
  fs.mkdirSync(extensionsDir);
  for (const [file, contents] of Object.entries({
    "package.json": JSON.stringify({ name: pluginId, version: "1.0.0", openclaw }),
    ...files,
  })) {
    const target = path.join(pluginDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  return { path: pluginDir, extensionsDir };
}

type EntryOptions = Pick<
  Parameters<typeof installPluginFromPath>[0],
  "dryRun" | "allowSourceTypeScriptEntries"
>;
type EntryCase = [
  title: string,
  extensions: string[],
  files: string[],
  errors: string[],
  metadata?: Record<string, unknown>,
  options?: EntryOptions,
];

it.each<EntryCase>([
  [
    "escaped entry",
    ["../src/index.ts"],
    [runtimeEntry],
    ["extension entry escapes plugin directory"],
    { runtimeExtensions: [runtimeEntry] },
  ],
  ["missing runtime", [runtimeEntry], [], ["extension entry not found"]],
  ["inferred built output", [sourceEntry], [runtimeEntry], []],
  [
    "blank extension",
    [runtimeEntry, " "],
    [runtimeEntry],
    ["openclaw.extensions[1]", "non-empty string"],
  ],
  [
    "missing compiled output",
    [sourceEntry],
    [sourceEntry],
    [
      "requires compiled runtime output",
      runtimeEntry,
      "plugin packaging issue",
      "retry installation after the publisher ships compiled JavaScript",
    ],
  ],
  [
    "linked source probe",
    [sourceEntry],
    [sourceEntry],
    [],
    {},
    { dryRun: true, allowSourceTypeScriptEntries: true },
  ],
  [
    "mismatched runtime count",
    ["./src/one.ts", "./src/two.ts"],
    ["dist/one.js"],
    ["runtimeExtensions length (1)", "extensions length (2)"],
    { runtimeExtensions: ["./dist/one.js"] },
  ],
  [
    "blank runtime",
    [sourceEntry],
    [sourceEntry, runtimeEntry],
    ["openclaw.runtimeExtensions[0]", "non-empty string"],
    { runtimeExtensions: [" "] },
  ],
  [
    "missing setup runtime",
    [runtimeEntry],
    [runtimeEntry, "src/setup-entry.ts"],
    ["runtime setup entry not found", "./dist/setup-entry.js"],
    { setupEntry: "./src/setup-entry.ts", runtimeSetupEntry: "./dist/setup-entry.js" },
  ],
])("package entries: %s", async (_title, extensions, paths, errors, metadata, options) => {
  const files = Object.fromEntries(paths.map((file) => [file, moduleSource]));
  const fixture = packageFixture({ extensions, ...metadata }, files);
  const result = await installPluginFromPath({ ...fixture, ...options });
  expect(result.ok).toBe(errors.length === 0);
  if (result.ok) {
    expect(result.pluginId).toBe(pluginId);
    if (options?.dryRun) {
      expect(result.targetDir).toBe(resolvePluginInstallDir(pluginId, fixture.extensionsDir));
    }
  } else {
    expect(result.code).toBe(PLUGIN_INSTALL_ERROR_CODE.INVALID_OPENCLAW_EXTENSIONS);
    expect(fs.existsSync(resolvePluginInstallDir(pluginId, fixture.extensionsDir))).toBe(false);
    expect(result.error).not.toContain("disable/uninstall");
    for (const error of errors) {
      expect(result.error).toContain(error);
    }
  }
});

it.each([
  ["runtime", "index.js", ".hidden/runtime.cjs"],
  ["setup", "index.js", ".hidden/setup.cjs"],
  ["inferred", ".hidden/index.ts", ".hidden/index.js"],
])("allows hidden %s entries without scanner warnings", async (kind, source, runtime) => {
  const setup = kind === "setup";
  const metadata = setup
    ? { setupEntry: "setup.ts", runtimeSetupEntry: runtime }
    : kind === "runtime"
      ? { runtimeExtensions: [runtime] }
      : {};
  const fixture = packageFixture(
    { extensions: [source], ...metadata },
    {
      [source]: source.endsWith(".ts") ? moduleSource : "module.exports = {};\n",
      ...(setup ? { "setup.ts": moduleSource } : {}),
      [runtime]:
        'const { execFileSync } = require("child_process");\nexecFileSync(process.execPath, ["-e", ""]);',
    },
  );
  const warnings: string[] = [];
  const result = await installPluginFromPath({
    ...fixture,
    logger: { warn: (message) => warnings.push(message) },
  });
  expect(result.ok).toBe(true);
  expect(warnings).toStrictEqual([]);
});
