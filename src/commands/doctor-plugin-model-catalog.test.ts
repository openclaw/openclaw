import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAuthProfileDatabaseOwnerId } from "../agents/auth-profiles/sqlite.js";
import {
  encodePluginModelCatalogRelativePath,
  loadPersistedPluginModelCatalogsReadOnly as readCatalogs,
  PLUGIN_MODEL_CATALOG_GENERATED_BY as GENERATED_BY,
  replacePersistedPluginModelCatalogs,
} from "../agents/plugin-model-catalog.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { maybeMigrateLegacyPluginModelCatalogs as migrateCatalogs } from "./doctor-plugin-model-catalog.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const tempDirs: string[] = [];

function createAgentDir(): string {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-model-catalog-"));
  tempDirs.push(agentDir);
  return agentDir;
}

function catalogContents(providers: Record<string, unknown>, pretty = false): string {
  const catalog = { generatedBy: GENERATED_BY, providers };
  return pretty ? `${JSON.stringify(catalog, null, 2)}\n` : JSON.stringify(catalog);
}
function generatedCatalog(provider: string, apiKey = "persisted-test-key"): string {
  return catalogContents(
    {
      [provider]: {
        api: "openai-completions",
        baseUrl: `https://${provider}.example/v1`,
        apiKey,
        models: [{ id: `${provider}-model`, name: `${provider} model` }],
      },
    },
    true,
  );
}

function writeLegacyCatalog(agentDir: string, pluginId: string, contents: string): string {
  const sourcePath = path.join(agentDir, encodePluginModelCatalogRelativePath(pluginId));
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, contents, "utf8");
  return sourcePath;
}

function migrationParams(agentDirs: string[], shouldRepair = true) {
  return {
    cfg: {} as OpenClawConfig,
    agentDirs,
    prompter: { confirmAutoFix: vi.fn(async () => shouldRepair), shouldRepair } as DoctorPrompter,
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    note: vi.fn(),
  };
}

async function expectMigration(
  params: Parameters<typeof migrateCatalogs>[0],
  overrides: Partial<Awaited<ReturnType<typeof migrateCatalogs>>> = {},
) {
  expect(await migrateCatalogs(params)).toEqual({
    detected: 0,
    migrated: 0,
    repaired: 0,
    removedRootCopies: 0,
    warnings: [],
    ...overrides,
  });
}

async function seedCatalogs(agentDir: string, catalogs: Record<string, string>) {
  await replacePersistedPluginModelCatalogs({
    agentDir,
    pluginCatalogWrites: Object.fromEntries(
      Object.entries(catalogs).map(([id, contents]) => [
        encodePluginModelCatalogRelativePath(id),
        contents,
      ]),
    ),
  });
}

function replaceCatalogRow(agentDir: string, pluginId: string, contents: string) {
  const database = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
  try {
    database
      .prepare(
        "UPDATE cache_entries SET value_json = ?, updated_at = 42 WHERE scope = ? AND key = ?",
      )
      .run(contents, "plugin-model-catalog-v1", pluginId);
  } finally {
    database.close();
  }
}

type CatalogRow = { value_json: string; updated_at: number };
function readCatalogCacheRow(agentDir: string, pluginId: string): CatalogRow {
  const database = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"), {
    readOnly: true,
  });
  try {
    const row = database
      .prepare("SELECT value_json, updated_at FROM cache_entries WHERE scope = ? AND key = ?")
      .get("plugin-model-catalog-v1", pluginId) as CatalogRow | undefined;
    if (!row) {
      throw new Error(`Missing generated catalog cache row for ${pluginId}`);
    }
    return row;
  } finally {
    database.close();
  }
}

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const agentDir of tempDirs.splice(0)) {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

describe("doctor generated plugin model catalog migration", () => {
  it("repairs only partial retained costs and persists the repair across reopening", async () => {
    const agentDir = createAgentDir();
    await seedCatalogs(agentDir, {
      ollama: generatedCatalog("ollama"),
      anthropic: generatedCatalog("anthropic"),
    });
    await closeOpenClawAgentDatabasesAsync(agentDir);
    const partial = {
      id: "partial",
      cost: { input: 1, output: 2, tieredPricing: [{ input: 3, output: 4 }] },
    };
    const unchanged = [
      { id: "priced", cost: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8 } },
      { id: "unpriced" },
      { id: "null-cost", cost: null },
      { id: "scalar-cost", cost: 3 },
      { id: "array-cost", cost: [] },
      { id: "null-rate", cost: { input: null, output: 2 } },
      { id: "string-rate", cost: { input: "1", output: 2 } },
    ];
    const provider = {
      api: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      apiKey: "preserved-provider-test-key",
      models: [partial, ...unchanged],
    };
    const retained = catalogContents({ ollama: provider });
    replaceCatalogRow(agentDir, "ollama", retained);
    const before = readCatalogCacheRow(agentDir, "ollama");
    const sibling = readCatalogCacheRow(agentDir, "anthropic");
    await expectMigration(migrationParams([agentDir], false), { detected: 1 });
    expect(readCatalogCacheRow(agentDir, "ollama")).toEqual(before);
    expect(readCatalogCacheRow(agentDir, "anthropic")).toEqual(sibling);

    const params = migrationParams([agentDir]);
    await expectMigration(params, { detected: 1, repaired: 1 });
    expect(params.note).toHaveBeenCalledWith(
      expect.stringContaining("completed the cost of 1 model row(s)"),
      "Doctor changes",
    );
    await closeOpenClawAgentDatabasesAsync(agentDir);
    const repaired = readCatalogCacheRow(agentDir, "ollama");
    expect(JSON.parse(repaired.value_json)).toEqual({
      generatedBy: GENERATED_BY,
      providers: {
        ollama: {
          ...provider,
          models: [
            { ...partial, cost: { ...partial.cost, cacheRead: 0, cacheWrite: 0 } },
            ...unchanged,
          ],
        },
      },
    });
    expect(readCatalogs(agentDir)).toContainEqual({
      pluginId: "ollama",
      contents: repaired.value_json,
    });
    expect(readCatalogCacheRow(agentDir, "anthropic")).toEqual(sibling);

    await expectMigration(migrationParams([agentDir]));
    expect(readCatalogCacheRow(agentDir, "ollama")).toEqual(repaired);
    expect(readCatalogCacheRow(agentDir, "anthropic")).toEqual(sibling);
  });

  it("does not report a repair when SQLite rejects the planned update", async () => {
    const agentDir = createAgentDir();
    const refreshed = generatedCatalog("nvidia", "concurrently-refreshed-provider-test-key");
    await seedCatalogs(agentDir, { nvidia: refreshed });
    const malformed = catalogContents({
      nvidia: {
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKey: "NVIDIA_API_KEY",
        models: [{ id: "meta-llama/llama-3.3-70b-instruct" }],
      },
    });
    const { db: database } = openOpenClawAgentDatabase({
      agentId: resolveAuthProfileDatabaseOwnerId(agentDir),
      path: path.join(agentDir, "openclaw-agent.sqlite"),
    });
    database
      .prepare(
        "UPDATE cache_entries SET value_json = ?, updated_at = 42 WHERE scope = ? AND key = ?",
      )
      .run(malformed, "plugin-model-catalog-v1", "nvidia");
    // Inject the write rejection on Doctor's admitted connection without changing persisted schema.
    database.exec("CREATE TEMP TABLE catalog_repair_refresh (value_json TEXT NOT NULL)");
    database.prepare("INSERT INTO catalog_repair_refresh (value_json) VALUES (?)").run(refreshed);
    database.exec(`
        CREATE TEMP TRIGGER refresh_catalog_before_repair
        BEFORE UPDATE OF value_json ON cache_entries
        WHEN OLD.scope = 'plugin-model-catalog-v1'
          AND OLD.key = 'nvidia'
          AND NEW.value_json != (SELECT value_json FROM catalog_repair_refresh)
        BEGIN
          UPDATE cache_entries
          SET value_json = (SELECT value_json FROM catalog_repair_refresh), updated_at = 99
          WHERE scope = OLD.scope AND key = OLD.key;
          SELECT RAISE(IGNORE);
        END
      `);

    const params = migrationParams([agentDir]);
    await expectMigration(params, { detected: 1 });
    expect(params.note).not.toHaveBeenCalledWith(expect.anything(), "Doctor changes");
    expect(readCatalogs(agentDir)).toEqual([{ pluginId: "nvidia", contents: refreshed }]);
    expect(readCatalogCacheRow(agentDir, "nvidia")).toEqual({
      value_json: refreshed,
      updated_at: 99,
    });
  });

  it("retires an orphaned recovery credential only on Doctor fix", async () => {
    const agentDir = createAgentDir();
    const contents = generatedCatalog("zai", "interrupted-released-provider-test-key");
    await seedCatalogs(agentDir, { zai: contents });
    const database = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
    try {
      database
        .prepare(
          "INSERT INTO cache_entries (scope, key, value_json, blob, expires_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?)",
        )
        .run("plugin-model-catalog-migration-v1", "zai", contents, Date.now());
    } finally {
      database.close();
    }

    await expectMigration(migrationParams([agentDir], false));
    expect(readCatalogs(agentDir)).toEqual([{ pluginId: "zai", contents }]);
    const verified = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"), {
      readOnly: true,
    });
    try {
      expect(
        verified
          .prepare("SELECT value_json FROM cache_entries WHERE scope = ?")
          .all("plugin-model-catalog-migration-v1"),
      ).toEqual([{ value_json: contents }]);
      await expectMigration(migrationParams([agentDir]));
      expect(
        verified
          .prepare("SELECT value_json FROM cache_entries WHERE scope = ?")
          .all("plugin-model-catalog-migration-v1"),
      ).toEqual([]);
    } finally {
      verified.close();
    }
  });

  it("imports a malformed shipped sidecar and preserves its credential", async () => {
    const agentDir = createAgentDir();
    const valid = generatedCatalog("zai", "persisted-zai-test-key");
    const contents = valid.replace('"api": "openai-completions",', "");
    const sourcePath = writeLegacyCatalog(agentDir, "zai", contents);

    await expectMigration(migrationParams([agentDir]), { detected: 1, migrated: 1, repaired: 1 });

    const persisted = readCatalogs(agentDir);
    expect(JSON.parse(persisted[0]!.contents).providers.zai).toEqual({
      baseUrl: "https://zai.example/v1",
      apiKey: "persisted-zai-test-key",
      models: [],
    });
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("discovers every explicit-roster agent without requiring a legacy default", async () => {
    const mainDir = createAgentDir();
    const helperDir = createAgentDir();
    const thirdDir = createAgentDir();
    const mainContents = generatedCatalog("openai", "main-explicit-provider-test-key");
    const helperContents = generatedCatalog("anthropic", "helper-explicit-provider-test-key");
    writeLegacyCatalog(mainDir, "openai", mainContents);
    writeLegacyCatalog(helperDir, "anthropic", helperContents);
    const params = {
      ...migrationParams([], true),
      agentDirs: undefined,
      cfg: {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "main" } },
          entries: {
            main: { agentDir: mainDir },
            helper: { agentDir: helperDir },
            third: { agentDir: thirdDir },
          },
        },
      } satisfies OpenClawConfig,
    };

    await expectMigration(params, { detected: 2, migrated: 2 });
    expect(readCatalogs(mainDir)).toEqual([{ pluginId: "openai", contents: mainContents }]);
    expect(readCatalogs(helperDir)).toEqual([{ pluginId: "anthropic", contents: helperContents }]);
  });

  it("preserves legacy credentials and does not create SQLite when repair is declined", async () => {
    const agentDir = createAgentDir();
    const contents = generatedCatalog("zai");
    const sourcePath = writeLegacyCatalog(agentDir, "zai", contents);
    fs.chmodSync(path.dirname(sourcePath), 0o755);
    const params = migrationParams([agentDir], false);

    await expectMigration(params, { detected: 1 });

    expect(params.prompter.confirmAutoFix).toHaveBeenCalledOnce();
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(contents);
    if (process.platform !== "win32") {
      expect(fs.statSync(path.dirname(sourcePath)).mode & 0o777).toBe(0o755);
    }
    expect(fs.existsSync(path.join(agentDir, "openclaw-agent.sqlite"))).toBe(false);
  });

  it("migrates readable providers when another legacy catalog is unreadable", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const agentDir = createAgentDir();
    const unreadablePath = writeLegacyCatalog(agentDir, "zai", generatedCatalog("zai"));
    const readableContents = generatedCatalog("anthropic", "readable-provider-test-key");
    const readablePath = writeLegacyCatalog(agentDir, "anthropic", readableContents);
    fs.chmodSync(unreadablePath, 0o000);

    try {
      const params = migrationParams([agentDir]);
      await expectMigration(params, {
        detected: 1,
        migrated: 1,
        warnings: [expect.stringContaining("Could not read legacy provider catalog")],
      });
      expect(params.runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("Could not read legacy provider catalog"),
      );
      expect(readCatalogs(agentDir)).toEqual([
        { pluginId: "anthropic", contents: readableContents },
      ]);
      expect(fs.existsSync(unreadablePath)).toBe(true);
      expect(fs.existsSync(readablePath)).toBe(false);
    } finally {
      fs.chmodSync(unreadablePath, 0o600);
    }
  });
});

describe("doctor generated catalog copies in root models.json", () => {
  // Released writers copied this discovery block under the claude-cli alias.
  const anthropicBlock = {
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    models: [
      {
        id: "claude-opus-5",
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      },
      {
        id: "claude-haiku-4-5",
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  };

  async function seedAgent(rootProviders: Record<string, unknown>) {
    const agentDir = createAgentDir();
    await seedCatalogs(agentDir, {
      anthropic: catalogContents({ anthropic: anthropicBlock }, true),
    });
    const rootRaw = `${JSON.stringify({ providers: rootProviders }, null, 2)}\n`;
    fs.writeFileSync(path.join(agentDir, "models.json"), rootRaw, "utf8");
    return { agentDir, rootRaw };
  }

  it("removes an exact copy once, keeping a byte-exact backup", async () => {
    const authored = { baseUrl: "https://proxy.example/v1", api: "openai-completions", models: [] };
    const { agentDir, rootRaw } = await seedAgent({
      "claude-cli": anthropicBlock,
      "my-proxy": authored,
    });

    const first = await migrateCatalogs(migrationParams([agentDir]));

    expect(first).toMatchObject({ detected: 1, removedRootCopies: 1, warnings: [] });
    expect(JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"))).toEqual({
      providers: { "my-proxy": authored },
    });
    const backups = fs.readdirSync(agentDir).filter((name) => name.startsWith("models.json.bak-"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(agentDir, backups[0]!), "utf8")).toBe(rootRaw);

    const second = await migrateCatalogs(migrationParams([agentDir]));
    expect(second).toMatchObject({ detected: 0, removedRootCopies: 0 });
  });

  it("keeps edited copies and ids that config declares", async () => {
    const edited = structuredClone(anthropicBlock);
    edited.models[1]!.cost = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
    const { agentDir: editedDir, rootRaw: editedRaw } = await seedAgent({ "claude-cli": edited });
    const { agentDir: configuredDir, rootRaw: configuredRaw } = await seedAgent({
      "claude-cli": anthropicBlock,
    });
    const configured = migrationParams([configuredDir]);
    configured.cfg = {
      models: { providers: { "claude-cli": { baseUrl: anthropicBlock.baseUrl, models: [] } } },
    } as OpenClawConfig;

    await expectMigration(migrationParams([editedDir]));
    await expectMigration(configured);
    expect(fs.readFileSync(path.join(editedDir, "models.json"), "utf8")).toBe(editedRaw);
    expect(fs.readFileSync(path.join(configuredDir, "models.json"), "utf8")).toBe(configuredRaw);
  });
});
