// Doctor plugin manifest tests cover manifest validation, missing installs, and repair guidance.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import {
  collectLegacyPluginManifestContractMigrations,
  legacyPluginManifestContractMigrationToHealthFinding,
  legacyPluginManifestSkipToHealthFinding,
  maybeRepairLegacyPluginManifestContracts,
  type LegacyPluginManifestSkip,
} from "./doctor-plugin-manifests.js";
import { createDoctorPrompter } from "./doctor-prompter.js";

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
  writeJson(root, "package.json", {
    name: "@openclaw/test-plugin",
    version: "1.0.0",
    openclaw: { extensions: ["./index.ts"] },
  });
  fs.writeFileSync(path.join(root, "index.ts"), "export default {};\n", "utf-8");
  writeJson(root, "openclaw.plugin.json", { configSchema: { type: "object" }, ...manifest });
  const runtime = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), exit: vi.fn() };
  return {
    root,
    params: {
      config: { plugins: { load: { paths: [pluginsRoot] } } } satisfies OpenClawConfig,
      env: { ...process.env },
      runtime,
      prompter: {
        ...createDoctorPrompter({ runtime, options: {} }),
        confirmAutoFix: vi.fn().mockResolvedValue(true),
      },
    },
  };
}

function writeJson(dir: string, name: string, value: unknown) {
  fs.writeFileSync(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

describe("doctor plugin manifest legacy contract repair", () => {
  beforeAll(async () => {
    fs.mkdirSync(fixturesRoot, { recursive: true });
    await suiteTempDirs.setup();
  });

  afterAll(async () => {
    await suiteTempDirs.cleanup();
  });

  it("maps legacy manifest migrations to structured health findings", async () => {
    const { root, params } = await createManifestFixture("finding-capability", {
      id: "openai",
      speechProviders: ["openai"],
    });

    const [migration] = collectLegacyPluginManifestContractMigrations(params);

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

    const changed = await maybeRepairLegacyPluginManifestContracts(params);
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

  it("leaves a legacy manifest with undecodable bytes untouched and reports it", async () => {
    const { root, params } = await createManifestFixture("undecodable-bytes", {
      id: "openai",
      tools: ["proof_tool"],
    });
    const manifestPath = path.join(root, "openclaw.plugin.json");
    // Decoding these bytes replaces 0xff with U+FFFD, so a repair would rewrite the
    // manifest with corrupted text instead of preserving the operator's file.
    const bytes = Buffer.concat([
      Buffer.from('{\n  "id": "openai",\n  "name": "Proof '),
      Buffer.from([0xff]),
      Buffer.from(
        ' legacy",\n  "configSchema": { "type": "object" },\n  "tools": ["proof_tool"]\n}\n',
      ),
    ]);
    fs.writeFileSync(manifestPath, bytes);
    const reason = `File is not valid UTF-8: ${manifestPath}; preserve its bytes and convert a copy to UTF-8 before retrying`;

    const skipped: LegacyPluginManifestSkip[] = [];
    expect(
      collectLegacyPluginManifestContractMigrations({
        ...params,
        onSkippedManifest: (skip) => skipped.push(skip),
      }),
    ).toStrictEqual([]);
    expect(skipped).toStrictEqual([{ manifestPath, reason }]);
    expect(legacyPluginManifestSkipToHealthFinding(skipped[0]!)).toStrictEqual({
      checkId: "core/doctor/legacy-plugin-manifests",
      severity: "warning",
      message: `Plugin manifest ${manifestPath} was not migrated: its bytes are not valid UTF-8.`,
      path: manifestPath,
      requirement: "utf8-manifest",
      fixHint:
        "Convert a copy of the manifest to UTF-8, then run `openclaw doctor --fix` to rewrite legacy capability keys under contracts.*.",
    });

    const changed = await maybeRepairLegacyPluginManifestContracts({ ...params });
    expect(changed).toBe(false);
    expect(fs.readFileSync(manifestPath).equals(bytes)).toBe(true);
  });

  it("removes duplicate legacy top-level plugin tools while keeping contracts.tools", async () => {
    const { root, params } = await createManifestFixture("dedupe-tool", {
      id: "cortex",
      tools: ["legacy_tool"],
      contracts: {
        tools: ["contract_tool"],
      },
    });

    await maybeRepairLegacyPluginManifestContracts(params);

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

    const migrations = collectLegacyPluginManifestContractMigrations(params);

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
