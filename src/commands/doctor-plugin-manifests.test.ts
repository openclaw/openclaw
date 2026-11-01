import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import {
  legacyPluginManifestContractMigrationToHealthFinding,
  maybeRepairLegacyPluginManifestContracts,
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

  it("maps legacy manifest migrations to structured health findings", () => {
    const migration = {
      manifestPath: "/synthetic/openclaw.plugin.json",
      pluginId: "openai",
      nextRaw: {},
      changeLines: [],
    };
    expect(legacyPluginManifestContractMigrationToHealthFinding(migration)).toStrictEqual({
      checkId: "core/doctor/legacy-plugin-manifests",
      severity: "warning",
      category: "fix-now",
      docsUrl: "https://docs.openclaw.ai/cli/doctor/checks",
      message: "Plugin manifest openai uses legacy top-level capability keys.",
      path: migration.manifestPath,
      target: "openai",
      requirement: "contracts-capability-keys",
      fixHint:
        "Run `openclaw doctor --fix` to rewrite legacy plugin manifest capability keys under contracts.*.",
    });
  });

  it.each([
    {
      name: "moves legacy capabilities while preserving other contracts",
      manifest: {
        id: "openai",
        providers: ["openai"],
        speechProviders: ["openai"],
        mediaUnderstandingProviders: ["openai"],
        contracts: { webSearchProviders: ["gemini"] },
      },
      expected: {
        id: "openai",
        providers: ["openai"],
        contracts: {
          speechProviders: ["openai"],
          mediaUnderstandingProviders: ["openai"],
          webSearchProviders: ["gemini"],
        },
      },
    },
    {
      name: "removes duplicate legacy tools while keeping contracts.tools",
      manifest: { id: "cortex", tools: ["legacy_tool"], contracts: { tools: ["contract_tool"] } },
      expected: { id: "cortex", contracts: { tools: ["contract_tool"] } },
    },
    {
      name: "replaces non-object contracts with migrated capabilities",
      manifest: {
        id: "openai",
        providers: ["openai"],
        speechProviders: ["openai"],
        contracts: "broken",
      },
      expected: { id: "openai", providers: ["openai"], contracts: { speechProviders: ["openai"] } },
    },
  ])("$name", async ({ name, manifest, expected }) => {
    const { root, params } = await createManifestFixture(name, manifest);
    expect(await maybeRepairLegacyPluginManifestContracts(params)).toBe(true);
    const next: unknown = JSON.parse(
      fs.readFileSync(path.join(root, "openclaw.plugin.json"), "utf-8"),
    );
    expect(next).toEqual({ configSchema: { type: "object" }, ...expected });
  });

  it("preserves undecodable manifests while migrating valid neighbors", async () => {
    const { root, params } = await createManifestFixture("invalid-utf8", {
      id: "invalid-utf8",
      name: "Invalid byte: X",
      tools: ["legacy_tool"],
    });
    const manifestPath = path.join(root, "openclaw.plugin.json");
    const original = fs.readFileSync(manifestPath);
    original[original.indexOf("X")] = 0xff;
    fs.writeFileSync(manifestPath, original);

    const neighbor = path.join(path.dirname(root), "valid-utf8");
    fs.cpSync(root, neighbor, { recursive: true });
    writeJson(neighbor, "openclaw.plugin.json", {
      id: "valid-utf8",
      name: "Valid replacement character: \ufffd",
      configSchema: { type: "object" },
      tools: ["valid_tool"],
    });

    expect(await maybeRepairLegacyPluginManifestContracts(params)).toBe(true);
    expect(fs.readFileSync(manifestPath)).toEqual(original);
    const warning = params.runtime.error.mock.calls.flat().join(" ");
    expect(warning).toContain("UTF-8");
    expect(warning).toContain(manifestPath);
    expect(
      JSON.parse(fs.readFileSync(path.join(neighbor, "openclaw.plugin.json"), "utf-8")),
    ).toEqual({
      id: "valid-utf8",
      name: "Valid replacement character: \ufffd",
      configSchema: { type: "object" },
      contracts: { tools: ["valid_tool"] },
    });
  });
});
