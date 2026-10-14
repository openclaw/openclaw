// Doctor plugin manifest tests cover manifest validation, missing installs, and repair guidance.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import {
  collectLegacyPluginManifestContractMigrations,
  legacyPluginManifestContractMigrationToHealthFinding,
  maybeRepairLegacyPluginManifestContracts,
} from "./doctor-plugin-manifests.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const fixturesRoot = path.join(process.cwd(), "dist", "extensions");
const suiteTempDirs = createSuiteTempRootTracker({
  prefix: "openclaw-doctor-plugin-manifests-",
  parentDir: fixturesRoot,
});

async function createManifestFixture(
  name: string,
  manifest: { id: string } & Record<string, unknown>,
) {
  const pluginsRoot = await suiteTempDirs.make(name);
  const root = path.join(pluginsRoot, manifest.id);
  fs.mkdirSync(root, { recursive: true });
  writePackageJson(root);
  writeManifest(root, { configSchema: { type: "object" }, ...manifest });
  return {
    root,
    params: {
      config: { plugins: { load: { paths: [pluginsRoot] } } } satisfies OpenClawConfig,
      env: { ...process.env },
      manifestRoots: [pluginsRoot],
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
  beforeAll(async () => {
    fs.mkdirSync(fixturesRoot, { recursive: true });
    await suiteTempDirs.setup();
  });

  afterAll(async () => {
    await suiteTempDirs.cleanup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps legacy manifest migrations to structured health findings", async () => {
    const { root, params } = await createManifestFixture("finding-capability", {
      id: "openai",
      speechProviders: ["openai"],
    });

    const [migration] = collectLegacyPluginManifestContractMigrations({
      ...params,
    });

    if (migration === undefined) {
      throw new Error("expected legacy manifest migration");
    }
    expect(legacyPluginManifestContractMigrationToHealthFinding(migration)).toStrictEqual({
      checkId: "core/doctor/legacy-plugin-manifests",
      severity: "warning",
      message: "Plugin manifest openai uses legacy top-level capability keys.",
      path: path.join(root, "openclaw.plugin.json"),
      target: "openai",
      requirement: "contracts-capability-keys",
      fixHint:
        "Run `openclaw doctor --fix` to rewrite legacy plugin manifest capability keys under contracts.*.",
    });
  });

  it("rewrites legacy top-level capability keys into contracts", async () => {
    const { root, params } = await createManifestFixture("rewrite-capability", {
      id: "openai",
      providers: ["openai"],
      speechProviders: ["openai"],
      mediaUnderstandingProviders: ["openai"],
      contracts: {
        webSearchProviders: ["gemini"],
      },
    });

    const changed = await maybeRepairLegacyPluginManifestContracts({
      ...params,
      runtime: createRuntime(),
      prompter: createPrompter(),
      note: vi.fn(),
    });
    expect(changed).toBe(true);

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

  it("removes duplicate legacy top-level plugin tools while keeping contracts.tools", async () => {
    const { root, params } = await createManifestFixture("dedupe-tool", {
      id: "cortex",
      tools: ["legacy_tool"],
      contracts: {
        tools: ["contract_tool"],
      },
    });

    await maybeRepairLegacyPluginManifestContracts({
      ...params,
      runtime: createRuntime(),
      prompter: createPrompter(),
      note: vi.fn(),
    });

    const next = JSON.parse(fs.readFileSync(path.join(root, "openclaw.plugin.json"), "utf-8")) as {
      tools?: string[];
      contracts?: Record<string, string[]>;
    };
    expect(next.tools).toBeUndefined();
    expect(next.contracts).toEqual({
      tools: ["contract_tool"],
    });
  });

  it("ignores non-object contracts payloads when collecting migrations", async () => {
    const { root, params } = await createManifestFixture("non-object-contracts", {
      id: "openai",
      providers: ["openai"],
      speechProviders: ["openai"],
      contracts: "broken",
    });

    const migrations = collectLegacyPluginManifestContractMigrations({
      ...params,
    });

    const manifestPath = path.join(root, "openclaw.plugin.json");
    expect(migrations).toStrictEqual([
      {
        changeLines: [`- ${manifestPath}: moved speechProviders to contracts.speechProviders`],
        manifestPath,
        nextRaw: {
          id: "openai",
          providers: ["openai"],
          contracts: {
            speechProviders: ["openai"],
          },
          configSchema: { type: "object" },
        },
        pluginId: "openai",
      },
    ]);
  });
});
