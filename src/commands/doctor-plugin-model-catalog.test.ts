// Doctor preserves provider credentials while migrating released catalog sidecars to SQLite.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAuthProfileDatabaseOwnerId } from "../agents/auth-profiles/sqlite.js";
import {
  encodePluginModelCatalogRelativePath,
  loadPersistedPluginModelCatalogsReadOnly,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  replacePersistedPluginModelCatalogs,
} from "../agents/plugin-model-catalog.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { maybeMigrateLegacyPluginModelCatalogs } from "./doctor-plugin-model-catalog.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const tempDirs: string[] = [];

function createAgentDir(): string {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-model-catalog-"));
  tempDirs.push(agentDir);
  return agentDir;
}

function generatedCatalog(provider: string, apiKey = "persisted-test-key"): string {
  return `${JSON.stringify(
    {
      generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
      providers: {
        [provider]: {
          api: "openai-completions",
          baseUrl: `https://${provider}.example/v1`,
          apiKey,
          models: [{ id: `${provider}-model`, name: `${provider} model` }],
        },
      },
    },
    null,
    2,
  )}\n`;
}

function writeLegacyCatalog(agentDir: string, pluginId: string, contents: string): string {
  const sourcePath = path.join(agentDir, encodePluginModelCatalogRelativePath(pluginId));
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, contents, "utf8");
  return sourcePath;
}

function prompter(shouldRepair: boolean): DoctorPrompter {
  return {
    confirmAutoFix: vi.fn(async () => shouldRepair),
    shouldRepair,
  } as unknown as DoctorPrompter;
}

function migrationParams(agentDirs: string[], shouldRepair = true) {
  return {
    cfg: {} as OpenClawConfig,
    agentDirs,
    prompter: prompter(shouldRepair),
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv,
    note: vi.fn(),
  };
}

function readCatalogCacheRow(
  agentDir: string,
  pluginId: string,
): {
  value_json: string;
  updated_at: number;
} {
  const database = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"), {
    readOnly: true,
  });
  try {
    const row = database
      .prepare("SELECT value_json, updated_at FROM cache_entries WHERE scope = ? AND key = ?")
      .get("plugin-model-catalog-v1", pluginId) as
      | { value_json: string; updated_at: number }
      | undefined;
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
  it("detects SQLite-only catalogs without repairing them", async () => {
    const agentDir = createAgentDir();
    const validSibling = generatedCatalog("anthropic");
    await replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: {
        [encodePluginModelCatalogRelativePath("zai")]: generatedCatalog("zai"),
        [encodePluginModelCatalogRelativePath("anthropic")]: validSibling,
      },
    });
    const malformed = JSON.stringify({
      generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
      providers: {
        zai: {
          apiKey: "preserved-provider-test-key",
          baseUrl: "https://zai.example/v1",
          models: [{ id: "missing-api" }, { id: "valid-api", api: "openai-completions" }],
        },
      },
    });
    const database = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
    try {
      database
        .prepare(
          "UPDATE cache_entries SET value_json = ?, updated_at = 42 WHERE scope = ? AND key = ?",
        )
        .run(malformed, "plugin-model-catalog-v1", "zai");
    } finally {
      database.close();
    }
    const before = loadPersistedPluginModelCatalogsReadOnly(agentDir);
    const siblingBefore = readCatalogCacheRow(agentDir, "anthropic");
    const malformedBefore = readCatalogCacheRow(agentDir, "zai");
    const params = migrationParams([agentDir], false);
    const result = await maybeMigrateLegacyPluginModelCatalogs(params);
    expect(result).toMatchObject({ detected: 1, migrated: 0, repaired: 0, warnings: [] });
    const after = loadPersistedPluginModelCatalogsReadOnly(agentDir);
    expect(readCatalogCacheRow(agentDir, "anthropic")).toEqual(siblingBefore);
    expect(after).toEqual(before);
    expect(readCatalogCacheRow(agentDir, "zai")).toEqual(malformedBefore);
  });

  it("does not report a repair when SQLite rejects the planned update", async () => {
    const agentDir = createAgentDir();
    const relativePath = encodePluginModelCatalogRelativePath("nvidia");
    const refreshed = generatedCatalog("nvidia", "concurrently-refreshed-provider-test-key");
    await replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: { [relativePath]: refreshed },
    });
    const malformed = JSON.stringify({
      generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
      providers: {
        nvidia: {
          baseUrl: "https://integrate.api.nvidia.com/v1",
          apiKey: "NVIDIA_API_KEY",
          models: [{ id: "meta-llama/llama-3.3-70b-instruct" }],
        },
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
    await expect(maybeMigrateLegacyPluginModelCatalogs(params)).resolves.toEqual({
      detected: 1,
      migrated: 0,
      repaired: 0,
      warnings: [],
    });
    expect(params.note).not.toHaveBeenCalledWith(expect.anything(), "Doctor changes");
    expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toEqual([
      { pluginId: "nvidia", contents: refreshed },
    ]);
    expect(readCatalogCacheRow(agentDir, "nvidia")).toEqual({
      value_json: refreshed,
      updated_at: 99,
    });
  });

  it("retires an orphaned recovery credential only on Doctor fix", async () => {
    const agentDir = createAgentDir();
    const contents = generatedCatalog("zai", "interrupted-released-provider-test-key");
    await replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: {
        [encodePluginModelCatalogRelativePath("zai")]: contents,
      },
    });
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

    await expect(
      maybeMigrateLegacyPluginModelCatalogs(migrationParams([agentDir], false)),
    ).resolves.toMatchObject({ detected: 0, migrated: 0, warnings: [] });
    expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toEqual([
      { pluginId: "zai", contents },
    ]);
    const verified = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"), {
      readOnly: true,
    });
    try {
      expect(
        verified
          .prepare("SELECT value_json FROM cache_entries WHERE scope = ?")
          .all("plugin-model-catalog-migration-v1"),
      ).toEqual([{ value_json: contents }]);
      await expect(
        maybeMigrateLegacyPluginModelCatalogs(migrationParams([agentDir])),
      ).resolves.toMatchObject({ detected: 0, migrated: 0, warnings: [] });
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

    await expect(
      maybeMigrateLegacyPluginModelCatalogs(migrationParams([agentDir])),
    ).resolves.toEqual({ detected: 1, migrated: 1, repaired: 1, warnings: [] });

    const persisted = loadPersistedPluginModelCatalogsReadOnly(agentDir);
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

    await expect(maybeMigrateLegacyPluginModelCatalogs(params)).resolves.toEqual({
      detected: 2,
      migrated: 2,
      repaired: 0,
      warnings: [],
    });
    expect(loadPersistedPluginModelCatalogsReadOnly(mainDir)).toEqual([
      { pluginId: "openai", contents: mainContents },
    ]);
    expect(loadPersistedPluginModelCatalogsReadOnly(helperDir)).toEqual([
      { pluginId: "anthropic", contents: helperContents },
    ]);
  });

  it("preserves legacy credentials and does not create SQLite when repair is declined", async () => {
    const agentDir = createAgentDir();
    const contents = generatedCatalog("zai");
    const sourcePath = writeLegacyCatalog(agentDir, "zai", contents);
    fs.chmodSync(path.dirname(sourcePath), 0o755);
    const params = migrationParams([agentDir], false);

    const result = await maybeMigrateLegacyPluginModelCatalogs(params);

    expect(params.prompter.confirmAutoFix).toHaveBeenCalledOnce();
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(contents);
    if (process.platform !== "win32") {
      expect(fs.statSync(path.dirname(sourcePath)).mode & 0o777).toBe(0o755);
    }
    expect(fs.existsSync(path.join(agentDir, "openclaw-agent.sqlite"))).toBe(false);
    expect(result).toEqual({
      detected: 1,
      migrated: 0,
      repaired: 0,
      warnings: [],
    });
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
      await expect(maybeMigrateLegacyPluginModelCatalogs(params)).resolves.toEqual({
        detected: 1,
        migrated: 1,
        repaired: 0,
        warnings: [expect.stringContaining("Could not read legacy provider catalog")],
      });
      expect(params.runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("Could not read legacy provider catalog"),
      );
      expect(loadPersistedPluginModelCatalogsReadOnly(agentDir)).toEqual([
        { pluginId: "anthropic", contents: readableContents },
      ]);
      expect(fs.existsSync(unreadablePath)).toBe(true);
      expect(fs.existsSync(readablePath)).toBe(false);
    } finally {
      fs.chmodSync(unreadablePath, 0o600);
    }
  });
});
