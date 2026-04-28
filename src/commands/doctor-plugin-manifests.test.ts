import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "../plugins/test-helpers/fs-fixtures.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  collectLegacyPluginManifestContractMigrations,
  maybeRepairLegacyPluginManifestContracts,
} from "./doctor-plugin-manifests.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const tempDirs: string[] = [];

function makeTempDir() {
  return makeTrackedTempDir("openclaw-doctor-plugin-manifests", tempDirs);
}

function makePluginWorkspace() {
  const workspaceDir = makeTempDir();
  return {
    workspaceDir,
    pluginsRoot: path.join(workspaceDir, ".openclaw", "extensions"),
    env: {
      ...process.env,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
      OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE: "1",
    },
  };
}

function configWithPluginLoadPath(pluginRoot: string): OpenClawConfig {
  return {
    plugins: {
      load: {
        paths: [pluginRoot],
      },
    },
  };
}

function writeManifest(dir: string, manifest: Record<string, unknown>) {
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf-8",
  );
}

function writePackageJson(dir: string) {
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: "@openclaw/test-plugin",
        version: "1.0.0",
        openclaw: {
          extensions: ["./index.ts"],
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  fs.writeFileSync(path.join(dir, "index.ts"), "export default {};\n", "utf-8");
}

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as RuntimeEnv;
}

function createPrompter(overrides: Partial<DoctorPrompter> = {}): DoctorPrompter {
  return {
    confirm: vi.fn(),
    confirmAutoFix: vi.fn().mockResolvedValue(true),
    confirmAggressiveAutoFix: vi.fn(),
    confirmRuntimeRepair: vi.fn(),
    select: vi.fn(),
    shouldRepair: false,
    shouldForce: false,
    repairMode: {
      shouldRepair: false,
      shouldForce: false,
      nonInteractive: false,
      canPrompt: true,
    },
    ...overrides,
  } as unknown as DoctorPrompter;
}

describe("doctor plugin manifest legacy contract repair", () => {
  afterEach(() => {
    cleanupTrackedTempDirs(tempDirs);
    vi.restoreAllMocks();
  });

  it("collects legacy top-level capability keys for migration", () => {
    const { pluginsRoot } = makePluginWorkspace();
    const root = path.join(pluginsRoot, "openai");
    fs.mkdirSync(root, { recursive: true });
    writePackageJson(root);
    writeManifest(root, {
      id: "openai",
      providers: ["openai"],
      speechProviders: ["openai"],
      configSchema: { type: "object" },
    });

    const migrations = collectLegacyPluginManifestContractMigrations({
      config: configWithPluginLoadPath(pluginsRoot),
      env: {
        ...process.env,
      },
      manifestRoots: [pluginsRoot],
    });

    expect(migrations).toHaveLength(1);
    expect(migrations[0]?.changeLines).toEqual([
      expect.stringContaining("moved speechProviders to contracts.speechProviders"),
    ]);
  });

  it("rewrites legacy top-level capability keys into contracts", async () => {
    const { pluginsRoot } = makePluginWorkspace();
    const root = path.join(pluginsRoot, "openai");
    fs.mkdirSync(root, { recursive: true });
    writePackageJson(root);
    writeManifest(root, {
      id: "openai",
      providers: ["openai"],
      speechProviders: ["openai"],
      mediaUnderstandingProviders: ["openai"],
      contracts: {
        webSearchProviders: ["gemini"],
      },
      configSchema: { type: "object" },
    });

    await maybeRepairLegacyPluginManifestContracts({
      config: configWithPluginLoadPath(pluginsRoot),
      env: {
        ...process.env,
      },
      manifestRoots: [pluginsRoot],
      runtime: createRuntime(),
      prompter: createPrompter(),
      note: vi.fn(),
    });

    const next = JSON.parse(fs.readFileSync(path.join(root, "openclaw.plugin.json"), "utf-8")) as {
      speechProviders?: string[];
      mediaUnderstandingProviders?: string[];
      contracts?: Record<string, string[]>;
    };
    expect(next.speechProviders).toBeUndefined();
    expect(next.mediaUnderstandingProviders).toBeUndefined();
    expect(next.contracts).toEqual({
      speechProviders: ["openai"],
      mediaUnderstandingProviders: ["openai"],
      webSearchProviders: ["gemini"],
    });
  });

  it("ignores non-object contracts payloads when collecting migrations", () => {
    const { pluginsRoot } = makePluginWorkspace();
    const root = path.join(pluginsRoot, "openai");
    fs.mkdirSync(root, { recursive: true });
    writePackageJson(root);
    writeManifest(root, {
      id: "openai",
      providers: ["openai"],
      speechProviders: ["openai"],
      contracts: "broken",
      configSchema: { type: "object" },
    });

    const migrations = collectLegacyPluginManifestContractMigrations({
      config: configWithPluginLoadPath(pluginsRoot),
      env: {
        ...process.env,
      },
      manifestRoots: [pluginsRoot],
    });

    expect(migrations).toHaveLength(1);
    expect(migrations[0]?.nextRaw.contracts).toEqual({
      speechProviders: ["openai"],
    });
  });
});
