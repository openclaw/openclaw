import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { publicPluginSdkSubpaths } from "../../scripts/lib/plugin-sdk-entries.mjs";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { defineToolPlugin, getToolPluginMetadata } from "../plugin-sdk/tool-plugin.js";
import { defaultRuntime } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import { VERSION } from "../version.js";
import { writeFixtureJsonSync } from "./cli-fixtures.test-support.js";
import {
  loadToolPlugin,
  runPluginsBuildCommand,
  runPluginsInitCommand,
  runPluginsValidateCommand,
} from "./plugins-authoring-command.js";
import {
  buildToolPluginManifest,
  buildToolPluginPackageManifest,
  validateToolPluginProject,
} from "./plugins-authoring-metadata.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const readText = (root: string, file: string) => fs.readFileSync(path.join(root, file), "utf8");
const readJson = (root: string, file: string) => JSON.parse(readText(root, file));
const writeJsonFile = (file: string, value: unknown) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2));

function createDemoMetadata(optional = false) {
  const entry = defineToolPlugin({
    id: optional ? "optional-demo-tools" : "demo-tools",
    name: optional ? "Optional Demo Tools" : "Demo Tools",
    description: optional ? "Optional demo tool plugin." : "Demo tool plugin.",
    tools: (tool) => [
      tool({
        name: optional ? "demo_optional_echo" : "demo_echo",
        description: "Echo input.",
        parameters: Type.Object({ input: Type.String() }),
        ...(optional ? { optional: true } : {}),
        execute: ({ input }) => ({ input }),
      }),
    ],
  });
  const metadata = getToolPluginMetadata(entry);
  if (!metadata) {
    throw new Error("missing metadata");
  }
  return metadata;
}

function sourceProject(
  id: string,
  root = tempDirs.make(`openclaw-plugin-${id}-`),
  toolName = `${id.replaceAll("-", "_")}_echo`,
) {
  const sourceDir = path.join(root, "src");
  fs.mkdirSync(sourceDir, { recursive: true });
  writeJsonFile(path.join(root, "package.json"), {
    name: `openclaw-plugin-${id}`,
    type: "module",
    openclaw: { extensions: ["./src/index.ts"] },
  });
  const entryPath = path.join(sourceDir, "index.ts");
  fs.writeFileSync(
    entryPath,
    `import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

export default defineToolPlugin({
  id: ${JSON.stringify(id)},
  name: "Source Demo",
  description: "Source demo plugin.",
  tools: (tool) => [
    tool({
      name: ${JSON.stringify(toolName)},
      description: "Echo input.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      execute: async () => ({ ok: true }),
    }),
  ],
});
`,
  );
  return { root, entry: entryPath };
}

function silenceRuntime(method: "writeJson" | "log" | "error") {
  return vi.spyOn(defaultRuntime, method).mockImplementation(() => {});
}

function interceptExit() {
  return vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
    throw new Error(`runtime exit ${code}`);
  });
}

describe("plugin authoring commands", () => {
  beforeAll(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-source-warm-"));
    try {
      const { entry: entryPath } = sourceProject("source-warm", tmpDir);
      await loadToolPlugin({ rootDir: tmpDir, entryPath });
    } finally {
      fs.rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("preserves manifest-owned metadata while updating generated fields", () => {
    const metadata = createDemoMetadata(true);
    const signals = {
      authSignals: [{ provider: "demo", envVars: ["DEMO_API_KEY"] }],
      configSignals: [{ rootPath: "plugins.entries.optional-demo-tools.config.apiKey" }],
    };
    const existingManifest = {
      id: "old-id",
      name: "Old name",
      uiHints: { apiKey: { secret: true } },
      contracts: {
        tools: ["stale_tool"],
        agentToolResultMiddleware: ["existing-middleware"],
      },
      toolMetadata: {
        demo_optional_echo: structuredClone(signals),
        stale_tool: { optional: true },
      },
    };

    const manifest = buildToolPluginManifest({
      metadata,
      packageManifest: { version: "1.2.3" },
      existingManifest,
    });

    expect(manifest).toMatchObject({
      id: "optional-demo-tools",
      name: "Optional Demo Tools",
      uiHints: { apiKey: { secret: true } },
      contracts: {
        tools: ["demo_optional_echo"],
        agentToolResultMiddleware: ["existing-middleware"],
      },
      toolMetadata: {
        demo_optional_echo: { optional: true, ...signals },
      },
    });
    expect((manifest.toolMetadata as Record<string, unknown>).stale_tool).toBeUndefined();
    expect(
      validateToolPluginProject({
        metadata,
        entry: "./src/index.ts",
        manifest,
        packageManifest: { version: "1.2.3", openclaw: { extensions: ["./src/index.ts"] } },
      }),
    ).toEqual([]);
  });

  it("aligns package metadata with the selected runtime extension entry", () => {
    expect(
      buildToolPluginPackageManifest({
        packageManifest: {
          name: "demo",
          openclaw: { setupEntry: "./setup.ts", extensions: ["./src/other.ts"] },
        },
        entry: "./src/index.ts",
      }),
    ).toEqual({
      name: "demo",
      openclaw: {
        setupEntry: "./setup.ts",
        extensions: ["./src/other.ts", "./src/index.ts"],
      },
    });
  });

  it("builds and installs selected entries without changing sibling runtime pairs", async () => {
    const { root: tmpDir, entry: sourceEntry } = sourceProject("entry-pairs");
    const packagePath = path.join(tmpDir, "package.json");
    const runtimeEntries = ["./dist/a/index.js", "./dist/b/other.js"];
    for (const entry of runtimeEntries) {
      fs.mkdirSync(path.dirname(path.join(tmpDir, entry)), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, entry), fs.readFileSync(sourceEntry));
    }
    const packageManifest = readJson(tmpDir, "package.json");
    packageManifest.openclaw = {
      extensions: ["./src/a/index.ts", "./src/b/index.ts"],
      runtimeExtensions: runtimeEntries,
    };
    writeFixtureJsonSync(packagePath, packageManifest);
    const { installPluginFromPath } = await import("../plugins/install-package.js");

    await runPluginsBuildCommand({ root: tmpDir, entry: runtimeEntries[0] });

    const generated = readJson(tmpDir, "package.json");
    const installed = await installPluginFromPath({
      path: tmpDir,
      extensionsDir: tempDirs.make("openclaw-plugin-entry-install-"),
    });
    expect(installed.ok, installed.ok ? undefined : installed.error).toBe(true);
    expect(installed).toMatchObject({ pluginId: "entry-pairs" });
    expect(generated.openclaw).toEqual({
      extensions: ["./dist/a/index.js", "./src/b/index.ts"],
      runtimeExtensions: runtimeEntries,
    });
    if (!installed.ok) {
      throw new Error(installed.error);
    }
    expect(readJson(installed.targetDir, "package.json")).toEqual(generated);
  });

  it.each<{
    extensions: string[];
    entry: string;
    expected: string[];
    runtimeExtensions?: string[];
  }>([
    {
      extensions: ["./dist/a/index.js", "./dist/b/index.js"],
      entry: "./src/a/index.ts",
      expected: ["./src/a/index.ts", "./dist/b/index.js"],
    },
    {
      extensions: ["./src/a/index.ts", "./src/b/index.ts"],
      entry: "./dist/b/index.js",
      expected: ["./src/a/index.ts", "./dist/b/index.js"],
    },
    {
      extensions: ["./src/a/index.js", "./dist/a/index.js"],
      entry: "./src/a/index.ts",
      expected: ["./src/a/index.js", "./src/a/index.ts"],
    },
    {
      extensions: ["./dist/src/index.mjs", "./src/other.ts"],
      entry: "./src/index.mts",
      expected: ["./src/index.mts", "./src/other.ts"],
    },
    {
      extensions: ["./dist/a/index.js", "./src/b/index.ts"],
      runtimeExtensions: ["./dist/a/index.js", "./dist/b/other.js"],
      entry: "./src/a/index.ts",
      expected: ["./src/a/index.ts", "./src/b/index.ts"],
    },
    {
      extensions: ["./src/a/index.ts", "./src/renamed.ts"],
      runtimeExtensions: ["./dist/unrelated.js", "./dist/a/index.js"],
      entry: "./dist/a/index.js",
      expected: ["./src/a/index.ts", "./dist/a/index.js"],
    },
  ])(
    "replaces only the full-path source/runtime counterpart for $entry",
    ({ extensions, entry, expected, runtimeExtensions }) => {
      expect(
        buildToolPluginPackageManifest({
          packageManifest: { openclaw: { extensions, runtimeExtensions } },
          entry,
        }),
      ).toEqual({ openclaw: { extensions: expected, runtimeExtensions } });
    },
  );

  it.each([
    { name: "Unicode", pluginId: "café-🦀", displayId: "café-🦀" },
    {
      name: "terminal controls",
      pluginId: "café\u001b[31m\nforged\trow\r🦀",
      displayId: "café\\nforged\\trow\\r🦀",
    },
  ])("renders $name in validation without changing metadata or JSON", async (testCase) => {
    const rootDir = tempDirs.make("openclaw-authoring-output-");
    sourceProject(testCase.pluginId, rootDir, "display_echo");
    writeJsonFile(path.join(rootDir, "package.json"), {
      ...readJson(rootDir, "package.json"),
      name: "openclaw-plugin-display",
    });
    await runPluginsBuildCommand({ root: rootDir });
    const before = fs.readFileSync(path.join(rootDir, "openclaw.plugin.json"));
    const log = silenceRuntime("log");
    const writeJson = silenceRuntime("writeJson");
    const error = silenceRuntime("error");
    await runPluginsValidateCommand({ root: rootDir });
    await runPluginsValidateCommand({ root: rootDir, json: true });

    expect(log).toHaveBeenCalledExactlyOnceWith(`Plugin ${testCase.displayId} is valid.`);
    expect(error).not.toHaveBeenCalled();
    expect(writeJson).toHaveBeenCalledExactlyOnceWith({
      valid: true,
      pluginId: testCase.pluginId,
      errors: [],
    });
    expect(fs.readFileSync(path.join(rootDir, "openclaw.plugin.json"))).toEqual(before);
    expect(readJson(rootDir, "openclaw.plugin.json").id).toBe(testCase.pluginId);
    expect(readText(rootDir, "src/index.ts")).toContain(JSON.stringify(testCase.pluginId));
  });

  it("reports and retires a preceding host browser declaration through explicit authoring", async () => {
    const { root: rootDir, entry: entryPath } = sourceProject("browser-authoring");
    const packagePath = path.join(rootDir, "package.json");
    const packageJson = readJson(rootDir, "package.json");
    packageJson.openclaw.controlUi = "./browser.ts";
    writeFixtureJsonSync(packagePath, packageJson);
    fs.writeFileSync(path.join(rootDir, "browser.ts"), 'export const label = "current";');
    fs.mkdirSync(path.join(rootDir, "node_modules"));
    fs.symlinkSync(
      path.resolve("node_modules/esbuild"),
      path.join(rootDir, "node_modules/esbuild"),
      "dir",
    );
    writeJsonFile(path.join(rootDir, "openclaw.plugin.json"), {
      channels: ["custom"],
      controlUi: {
        entry: "dist/control-ui/authored/index.js",
        activation: "settings-only",
        settingsViews: [{ section: "channels", panel: "detail", channelId: "custom" }],
      },
    });
    await runPluginsBuildCommand({ root: rootDir, entry: entryPath });
    await runPluginsBuildCommand({ root: rootDir, entry: entryPath, check: true });
    const generatedPath = path.join(rootDir, "dist/openclaw.plugin.json");
    writeFixtureJsonSync(generatedPath, { controlUi: { entry: "dist/control-ui/stale/index.js" } });
    interceptExit();
    silenceRuntime("error");
    await expect(
      runPluginsBuildCommand({ root: rootDir, entry: entryPath, check: true }),
    ).rejects.toThrow("runtime exit 1");
    expect(fs.existsSync(generatedPath)).toBe(true);
    await runPluginsBuildCommand({ root: rootDir, entry: entryPath });
    expect(fs.existsSync(generatedPath)).toBe(false);
    const authoredPath = path.join(rootDir, "openclaw.plugin.json");
    const authoredBeforeFailure = fs.readFileSync(authoredPath, "utf8");
    const previousEntry = JSON.parse(authoredBeforeFailure).controlUi.entry;
    const previousAssets = fs.readFileSync(path.join(rootDir, previousEntry));
    fs.mkdirSync(generatedPath);
    fs.writeFileSync(path.join(generatedPath, "unowned.txt"), "preserve");
    fs.writeFileSync(path.join(rootDir, "browser.ts"), 'export const label = "next";');
    await expect(runPluginsBuildCommand({ root: rootDir, entry: entryPath })).rejects.toThrow();
    expect(fs.readFileSync(authoredPath, "utf8")).toBe(authoredBeforeFailure);
    expect(fs.readFileSync(path.join(rootDir, previousEntry))).toEqual(previousAssets);
    expect(fs.readFileSync(path.join(generatedPath, "unowned.txt"), "utf8")).toBe("preserve");
  });

  it("preserves shared output when authoring a backend without browser source", async () => {
    const { root: rootDir, entry: entryPath } = sourceProject("backend-authoring");
    const outside = tempDirs.make("openclaw-plugin-shared-output-");
    const outsideManifest = path.join(outside, "openclaw.plugin.json");
    fs.writeFileSync(outsideManifest, '{"id":"other-project"}');
    fs.symlinkSync(
      outside,
      path.join(rootDir, "dist"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await runPluginsBuildCommand({ root: rootDir, entry: entryPath });
    expect(fs.readFileSync(outsideManifest, "utf8")).toBe('{"id":"other-project"}');
  });

  it("keeps validation errors on stderr and sanitizes JSON paths", async () => {
    const homeDir = tempDirs.make("openclaw-plugin-invalid-json-home-");
    const rootDir = path.join(homeDir, "plugins", "invalid-json");
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(path.join(rootDir, "package.json"), "{}\n");
    const writeJson = silenceRuntime("writeJson");
    const log = silenceRuntime("log");
    const error = silenceRuntime("error");
    const exit = interceptExit();
    await expect(
      withEnvAsync({ OPENCLAW_HOME: homeDir }, async () => {
        await runPluginsValidateCommand({ root: rootDir, json: true });
      }),
    ).rejects.toThrow("runtime exit 1");

    expect(writeJson).toHaveBeenCalledWith({
      valid: false,
      errors: [
        "plugin manifest not found: $OPENCLAW_HOME/plugins/invalid-json/openclaw.plugin.json",
      ],
    });
    expect(error).toHaveBeenCalledWith(
      `plugin manifest not found: ${rootDir}/openclaw.plugin.json`,
    );
    expect(log).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1, { resetStream: process.stderr });
  });

  it.each(["validate", "build --check"] as const)(
    "accepts reordered JSON object keys without rewriting files in %s",
    async (command) => {
      const { root: tmpDir, entry: entryPath } = sourceProject("reordered-json");
      await runPluginsBuildCommand({ root: tmpDir, entry: entryPath });

      const manifestPath = path.join(tmpDir, "openclaw.plugin.json");
      const manifest = readJson(tmpDir, "openclaw.plugin.json") as Record<string, unknown>;
      const configSchema = manifest.configSchema as Record<string, unknown>;
      writeJsonFile(manifestPath, {
        ...manifest,
        configSchema: {
          properties: configSchema.properties,
          additionalProperties: configSchema.additionalProperties,
          type: configSchema.type,
        },
      });
      const packagePath = path.join(tmpDir, "package.json");
      const manifestBefore = fs.readFileSync(manifestPath, "utf8");
      const packageBefore = fs.readFileSync(packagePath, "utf8");
      const exit = interceptExit();
      const log = silenceRuntime("log");
      const error = silenceRuntime("error");
      if (command === "validate") {
        await runPluginsValidateCommand({ root: tmpDir, entry: entryPath });
        expect(log).toHaveBeenCalledWith("Plugin reordered-json is valid.");
      } else {
        await runPluginsBuildCommand({ root: tmpDir, entry: entryPath, check: true });
        expect(log).toHaveBeenCalledWith("Plugin metadata is up to date.");
      }
      expect(exit).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(fs.readFileSync(manifestPath, "utf8")).toBe(manifestBefore);
      expect(fs.readFileSync(packagePath, "utf8")).toBe(packageBefore);
    },
  );

  it("projects undefined TypeBox options into the persisted manifest shape", () => {
    const entry = defineToolPlugin({
      id: "undefined-schema-options",
      name: "Undefined Schema Options",
      description: "Plugin with optional TypeBox schema metadata.",
      configSchema: Type.Object(
        { value: Type.Optional(Type.String({ description: undefined })) },
        { description: undefined },
      ),
      tools: (tool) => [
        tool({
          name: "undefined_schema_echo",
          description: "Echo input.",
          parameters: Type.Object({ input: Type.String() }),
          execute: ({ input }) => ({ input }),
        }),
      ],
    });
    const metadata = getToolPluginMetadata(entry);
    if (!metadata) {
      throw new Error("missing metadata");
    }
    const runtimeSchema = metadata.configSchema;
    const runtimeProperties = runtimeSchema.properties as Record<string, unknown>;
    expect(Object.hasOwn(runtimeSchema, "description")).toBe(true);
    expect(Object.hasOwn(runtimeProperties.value as object, "description")).toBe(true);

    const packageManifest = { version: "1.2.3", openclaw: { extensions: ["./src/index.ts"] } };
    const manifest = buildToolPluginManifest({ metadata, packageManifest });
    const persistedSchema = manifest.configSchema as Record<string, unknown>;
    const persistedProperties = persistedSchema.properties as Record<string, unknown>;
    expect(Object.hasOwn(persistedSchema, "description")).toBe(false);
    expect(Object.hasOwn(persistedProperties.value as object, "description")).toBe(false);
    expect(
      validateToolPluginProject({
        metadata,
        entry: "./src/index.ts",
        manifest,
        packageManifest,
      }),
    ).toEqual([]);
  });

  it("rejects a missing generated manifest without changing package metadata", async () => {
    const { root: tmpDir, entry: entryPath } = sourceProject("missing-generated-manifest");
    const packagePath = path.join(tmpDir, "package.json");
    const packageBefore = fs.readFileSync(packagePath, "utf8");
    interceptExit();
    const error = silenceRuntime("error");
    await expect(
      runPluginsBuildCommand({ root: tmpDir, entry: entryPath, check: true }),
    ).rejects.toThrow("runtime exit 1");
    expect(error).toHaveBeenCalledWith(
      "Generated plugin metadata is out of date. Run openclaw plugins build.",
    );
    expect(fs.readFileSync(packagePath, "utf8")).toBe(packageBefore);
    expect(fs.existsSync(path.join(tmpDir, "openclaw.plugin.json"))).toBe(false);
  });

  it("reports stale manifest contracts", () => {
    const metadata = createDemoMetadata();

    expect(
      validateToolPluginProject({
        metadata,
        entry: "./src/index.ts",
        manifest: {
          id: "demo-tools",
          configSchema: {},
          contracts: { tools: ["other_tool"] },
        },
        packageManifest: { openclaw: { extensions: ["./src/index.ts"] } },
      }),
    ).toEqual([
      "openclaw.plugin.json generated metadata is stale. Run openclaw plugins build.",
      "openclaw.plugin.json contracts.tools is missing: demo_echo",
      "openclaw.plugin.json contracts.tools has no matching defineToolPlugin tool: other_tool",
    ]);
  });

  it("reports missing entries with an author-facing path", async () => {
    const tmpDir = tempDirs.make("openclaw-plugin-missing-");

    await expect(
      loadToolPlugin({ rootDir: tmpDir, entryPath: path.join(tmpDir, "dist/index.js") }),
    ).rejects.toThrow("plugin entry not found: ./dist/index.js");
  });

  it("throws a user-friendly error when package.json is malformed JSON", async () => {
    const { root: tmpDir, entry: entryPath } = sourceProject("bad-json");
    const packagePath = path.join(tmpDir, "package.json");
    fs.writeFileSync(packagePath, "{invalid json");

    await expect(runPluginsBuildCommand({ root: tmpDir, entry: entryPath })).rejects.toThrow(
      `Malformed JSON in ${packagePath}`,
    );
  });

  it("finishes a build from an absolute root after the launch directory is removed", async () => {
    const tmpDir = tempDirs.make("openclaw-plugin-deleted-cwd-build-");
    const packagePath = path.join(tmpDir, "package.json");
    const { entry: entryPath } = sourceProject("deleted-cwd-build", tmpDir, "deleted_cwd_echo");
    const originalCwd = process.cwd();
    let cwdRemoved = false;
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    vi.spyOn(process, "cwd").mockImplementation(() => {
      if (cwdRemoved) {
        throw new Error("ENOENT: no such file or directory, uv_cwd");
      }
      return originalCwd;
    });
    const realOpen = fsp.open.bind(fsp);
    vi.spyOn(fsp, "open").mockImplementation(async (file, flags, mode) => {
      const handle = await realOpen(file, flags, mode);
      if (String(file).startsWith(tmpDir) && String(file).endsWith(".tmp")) {
        cwdRemoved = true;
      }
      return handle;
    });

    await runPluginsBuildCommand({ root: tmpDir, entry: entryPath });
    expect(fs.existsSync(path.join(tmpDir, "openclaw.plugin.json"))).toBe(true);
    expect(log).toHaveBeenCalledWith(`Wrote ${path.join(tmpDir, "openclaw.plugin.json")}`);
    expect(log).toHaveBeenCalledWith(`Updated ${packagePath}`);
    expect(cwdRemoved).toBe(true);
  });

  it("builds and checks metadata through a symlink project root", async () => {
    const tmpDir = tempDirs.make("openclaw-plugin-symlink-root-");
    const projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(projectDir);
    sourceProject("symlink-root", projectDir);
    const linkedRoot = path.join(tmpDir, "linked-project");
    fs.symlinkSync(projectDir, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    const manifestPath = path.join(projectDir, "openclaw.plugin.json");
    fs.writeFileSync(manifestPath, '{"id":"previous"}\n');
    if (process.platform !== "win32") {
      fs.chmodSync(manifestPath, 0o640);
      fs.chmodSync(projectDir, 0o3770);
    }
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const opts = { root: linkedRoot, entry: path.join(linkedRoot, "src", "index.ts") };

    try {
      await runPluginsBuildCommand(opts);
      expect(readJson(projectDir, "package.json")).toMatchObject({
        openclaw: { extensions: ["./src/index.ts"] },
      });
      expect(readJson(projectDir, "openclaw.plugin.json")).toMatchObject({
        id: "symlink-root",
        contracts: { tools: ["symlink_root_echo"] },
      });
      const manifestBeforeCheck = fs.readFileSync(manifestPath);
      const packageBeforeCheck = fs.readFileSync(path.join(projectDir, "package.json"));
      await runPluginsBuildCommand({ ...opts, check: true });
      expect(log).toHaveBeenCalledWith("Plugin metadata is up to date.");
      expect(fs.readFileSync(manifestPath)).toEqual(manifestBeforeCheck);
      expect(fs.readFileSync(path.join(projectDir, "package.json"))).toEqual(packageBeforeCheck);
      if (process.platform !== "win32") {
        expect(fs.statSync(manifestPath).mode & 0o7777).toBe(0o640);
        expect(fs.statSync(projectDir).mode & 0o7777).toBe(0o3770);
      }
    } finally {
      log.mockRestore();
    }
  });

  it("keeps the project intact when package publication fails during write", async () => {
    const { root: tmpDir, entry: entryPath } = sourceProject("build-failure");
    const packagePath = path.join(tmpDir, "package.json");
    fs.chmodSync(packagePath, 0o640);
    fs.chmodSync(tmpDir, 0o3770);
    const originalPackage = fs.readFileSync(packagePath);
    const originalMode = fs.statSync(packagePath).mode & 0o7777;
    const originalDirectoryMode = fs.statSync(tmpDir).mode & 0o7777;
    const originalEntries = fs.readdirSync(tmpDir).toSorted();
    const error = Object.assign(new Error("publication failed"), { code: "ENOSPC" });
    let stagedHandle: Awaited<ReturnType<typeof fsp.open>> | undefined;
    const realOpen = fsp.open.bind(fsp);
    vi.spyOn(fsp, "open").mockImplementation(async (file, flags, mode) => {
      const handle = await realOpen(file, flags, mode);
      if (String(file).startsWith(tmpDir) && String(file).endsWith(".tmp")) {
        stagedHandle = handle;
      }
      return handle;
    });
    const realWrite = fsp.writeFile.bind(fsp);
    vi.spyOn(fsp, "writeFile").mockImplementation(async (file, data, options) => {
      if (file === stagedHandle) {
        await realWrite(file, "partial");
        throw error;
      }
      return realWrite(file, data, options);
    });
    const realWriteSync = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
      if (file === packagePath) {
        realWriteSync(file, "partial");
        throw error;
      }
      return realWriteSync(file, data, options);
    });
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});

    await expect(runPluginsBuildCommand({ root: tmpDir, entry: entryPath })).rejects.toMatchObject({
      code: error.code,
    });
    expect(fs.readFileSync(packagePath)).toEqual(originalPackage);
    expect(fs.statSync(packagePath).mode & 0o7777).toBe(originalMode);
    expect(fs.statSync(tmpDir).mode & 0o7777).toBe(originalDirectoryMode);
    expect(fs.readdirSync(tmpDir).toSorted()).toEqual(originalEntries);
    expect(log).not.toHaveBeenCalled();
  });

  it("reports a manifest rename failure after publishing package metadata", async () => {
    const { root: tmpDir, entry: entryPath } = sourceProject("manifest-failure");
    const packagePath = path.join(tmpDir, "package.json");
    const manifestPath = path.join(tmpDir, "openclaw.plugin.json");
    const packageManifest = readJson(tmpDir, "package.json");
    packageManifest.openclaw.extensions = [];
    writeFixtureJsonSync(packagePath, packageManifest);
    const packageBefore = fs.readFileSync(packagePath);
    const manifestBefore = '{\n  "id": "previous"\n}\n';
    fs.writeFileSync(manifestPath, manifestBefore);
    const error = Object.assign(new Error("manifest publication failed"), { code: "EPERM" });
    let packagePublications = 0;
    let manifestFailureInjected = false;
    const realRename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      if (to === manifestPath && packagePublications === 1) {
        manifestFailureInjected = true;
        throw error;
      }
      await realRename(from, to);
      if (to === packagePath) {
        packagePublications += 1;
      }
    });
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});

    await expect(runPluginsBuildCommand({ root: tmpDir, entry: entryPath })).rejects.toMatchObject({
      code: error.code,
    });
    expect(packagePublications).toBe(1);
    expect(manifestFailureInjected).toBe(true);
    expect(fs.readFileSync(packagePath)).not.toEqual(packageBefore);
    expect(readJson(tmpDir, "package.json")).toMatchObject({
      openclaw: { extensions: ["./src/index.ts"] },
    });
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(manifestBefore);
    expect(fs.readdirSync(tmpDir).toSorted()).toEqual([
      "openclaw.plugin.json",
      "package.json",
      "src",
    ]);
    expect(log).not.toHaveBeenCalled();
  });

  it("finishes init with an absolute directory after the launch directory is removed", async () => {
    const tmpDir = tempDirs.make("openclaw-plugin-deleted-cwd-init-");
    const projectDir = path.join(tmpDir, "demo");
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory, uv_cwd");
    });

    await runPluginsInitCommand("demo", { directory: projectDir });
    expect(fs.existsSync(path.join(projectDir, "package.json"))).toBe(true);
    expect(log).toHaveBeenCalledWith(`Created ${projectDir}`);
  });

  it("scaffolds a provider plugin project with ClawHub validation and release metadata", async () => {
    const tmpDir = tempDirs.make("openclaw-provider-init-");
    const projectDir = path.join(tmpDir, "plugin-init-test");

    await runPluginsInitCommand("plugin-init-test", {
      directory: projectDir,
      name: "Plugin Init Test",
      type: "provider",
    });

    const packageManifest = readJson(projectDir, "package.json");
    expect(packageManifest).toMatchObject({
      name: "openclaw-plugin-plugin-init-test",
      scripts: {
        build: "tsc -p tsconfig.json",
        test: "vitest run --config ./vitest.config.ts",
        validate: "npm run build && clawhub package validate . --out .clawhub-validation",
      },
      peerDependencies: { openclaw: `>=${VERSION}` },
      devDependencies: {
        clawhub: "latest",
        openclaw: "latest",
        typescript: "7.0.2",
        vitest: "^3.2.0",
      },
      openclaw: {
        extensions: ["./dist/index.js"],
        install: {
          clawhubSpec: "clawhub:openclaw-plugin-plugin-init-test",
          defaultChoice: "clawhub",
          minHostVersion: `>=${VERSION}`,
        },
        compat: { pluginApi: `>=${VERSION}` },
        build: { openclawVersion: VERSION },
        release: { publishToClawHub: true },
      },
    });
    expect(packageManifest.scripts).not.toHaveProperty("plugin:build");
    expect(packageManifest.scripts).not.toHaveProperty("plugin:validate");

    const manifest = readJson(projectDir, "openclaw.plugin.json");
    expect(manifest).toMatchObject({
      id: "plugin-init-test",
      name: "Plugin Init Test",
      version: "0.1.0",
      providers: ["plugin-init-test"],
      setup: {
        providers: [{ id: "plugin-init-test", envVars: ["PLUGIN_INIT_TEST_API_KEY"] }],
      },
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    });

    const indexSource = readText(projectDir, "src/index.ts");
    expect(indexSource).toContain("definePluginEntry");
    expect(indexSource).toContain("api.registerProvider");
    for (const [, subpath] of indexSource.matchAll(/from "openclaw\/plugin-sdk\/([^"]+)"/g)) {
      expect(publicPluginSdkSubpaths).toContain(subpath);
    }

    expect(readText(projectDir, "src/index.test.ts")).toContain("OpenClawPluginApi");
    expect(readText(projectDir, "vitest.config.ts")).toContain('include: ["src/**/*.test.ts"]');
    const readme = readText(projectDir, "README.md");
    expect(readme).toContain("npm run validate");
    expect(readme).toContain("npm exec clawhub -- login");
    expect(readme).toContain("npm exec clawhub -- package publish .");
    expect(readme).toContain("npm exec clawhub -- package trusted-publisher set");

    const workflow = readText(projectDir, ".github/workflows/clawhub-publish.yml");
    expect(workflow).not.toContain("release:");
    expect(workflow).not.toContain("secrets: inherit");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain(
      "openclaw/clawhub/.github/workflows/package-publish.yml@9d49df109d4ad3dc8a6ecf05d26b39f46d294721",
    );
  });
});
