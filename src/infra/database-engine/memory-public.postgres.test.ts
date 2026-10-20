import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getEnvironmentData } from "node:worker_threads";
import { Command } from "commander";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { resolveDefaultSessionStorePath } from "../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "../../plugin-sdk/plugin-state-runtime.js";
import { createPluginStateKeyedStoreForTests } from "../../plugin-sdk/plugin-state-test-runtime.js";
import { upsertSessionEntry } from "../../plugin-sdk/session-store-runtime.js";
import { appendSessionTranscriptMessageByIdentity } from "../../plugin-sdk/session-transcript-runtime.js";
import {
  clearEmbeddingProviders,
  registerEmbeddingProvider,
  type EmbeddingInput,
} from "../../plugins/embedding-providers.js";
import type { MemoryPluginRuntime } from "../../plugins/registry-contribution-types.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { admitSqliteSchema } from "../sqlite-schema-facts.js";
import { installDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import { resolveDatabaseFamilyEngines } from "./registry.js";

const configured: unknown = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const prefix = `mempublic_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
const keywordDatabase = `${prefix}_keyword`;
const noTrigramDatabase = `${prefix}_no_trigram`;
const noUnaccentDatabase = `${prefix}_no_unaccent`;
const providerId = "postgres-memory-fixture";
let root: string;
const capabilityRoots: string[] = [];
let workspace: string;
let client: pg.Client;
let runtime: MemoryPluginRuntime;
const stateAnchors: DatabaseSync[] = [];
type MemoryCliHost = {
  runInBackgroundContext: <T>(run: () => T) => T;
  openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>;
};
let host: MemoryCliHost;

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    if (!connection) {
      return;
    }
    try {
      await runtime?.closeAllMemorySearchManagers?.();
      if (root) {
        await cleanupSessionStateForTest({ stateDir: root });
      }
      for (const stateDir of capabilityRoots) {
        await cleanupSessionStateForTest({ stateDir });
      }
      const schemas = await client.query<{ nspname: string }>(
        "SELECT nspname FROM pg_namespace WHERE left(nspname, $1) = $2",
        [prefix.length + 1, `${prefix}_`],
      );
      for (const { nspname } of schemas.rows) {
        await client.query(`DROP SCHEMA "${nspname.replaceAll('"', '""')}" CASCADE`);
      }
      await client.query(`DROP DATABASE IF EXISTS "${keywordDatabase}" WITH (FORCE)`);
      await client.query(`DROP DATABASE IF EXISTS "${noTrigramDatabase}" WITH (FORCE)`);
      await client.query(`DROP DATABASE IF EXISTS "${noUnaccentDatabase}" WITH (FORCE)`);
    } finally {
      await client?.end();
      for (const anchor of stateAnchors) {
        anchor.close();
      }
      clearEmbeddingProviders();
      clearRuntimeConfigSnapshot();
      resetDatabaseEngineSelectionForTest();
      vi.unstubAllEnvs();
      cleanup();
    }
  }),
);

function config(): OpenClawConfig {
  return {
    database: {
      engine: "postgres",
      postgres: {
        connection: { source: "env", provider: "default", id: "OPENCLAW_MEMORY_PUBLIC_POSTGRES" },
        schemaPrefix: prefix,
      },
    },
    plugins: { enabled: false },
    agents: {
      ownership: "explicit",
      entries: { main: { workspace }, semantic: { workspace } },
    },
    memory: {
      search: {
        provider: providerId,
        model: "synthetic-three-dimensions",
        fallback: "none",
        sources: ["memory", "sessions"],
        rememberAcrossConversations: true,
        query: { minScore: 0.01 },
      },
    },
  };
}

function embedding(input: EmbeddingInput): number[] {
  const text = (typeof input === "string" ? input : input.text).toLowerCase();
  return [
    Number(text.includes("sapphire") || text.includes("blue-coordinate")),
    Number(text.includes("ruby")),
    Number(text.includes("amethyst")),
  ];
}

async function managerFor(
  cfg: OpenClawConfig,
  purpose: "cli" | "status" = "cli",
  agentId = "main",
  inspectSources = false,
) {
  setRuntimeConfigSnapshot(cfg);
  const result = await runtime.getMemorySearchManager({ cfg, agentId, purpose, inspectSources });
  assert(result.manager, result.error ?? "Expected public PostgreSQL memory manager");
  return result.manager;
}

async function runMemoryCommand(args: string[]) {
  const { registerMemoryCli } = await vi.importActual<{
    registerMemoryCli: (program: Command, host: MemoryCliHost) => void;
  }>("../../../extensions/memory-core/runtime-api.js");
  const program = new Command().exitOverride();
  registerMemoryCli(program, host);
  await program.parseAsync(["memory", ...args], { from: "user" });
  expect(process.exitCode ?? 0).toBe(0);
}

function admitStateAnchor(stateRoot: string) {
  const pathname = path.join(stateRoot, "state", "openclaw.sqlite");
  const anchor = openNodeSqliteDatabase(pathname);
  admitSqliteSchema(anchor);
  stateAnchors.push(anchor);
}

async function selectCapabilityDatabase(name: string) {
  await runtime.closeAllMemorySearchManagers?.();
  await cleanupSessionStateForTest({ stateDir: capabilityRoots.at(-1) ?? root });
  const stateRoot = tempDirs.make("memory-public-capability-postgres-");
  capabilityRoots.push(stateRoot);
  await fs.mkdir(path.join(stateRoot, "state"));
  await fs.writeFile(path.join(stateRoot, "state", "openclaw.sqlite"), "", { flag: "wx" });
  vi.stubEnv("OPENCLAW_STATE_DIR", stateRoot);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateRoot, "openclaw.json"));
  const url = new URL(connection!);
  url.pathname = `/${name}`;
  vi.stubEnv("OPENCLAW_MEMORY_PUBLIC_POSTGRES", url.href);
  resetDatabaseEngineSelectionForTest();
  installDatabaseEngineSelection({
    effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
    postgres: { connection: url.href, schemaPrefix: prefix },
  });
  admitStateAnchor(stateRoot);
}

describe.skipIf(!connection)("public PostgreSQL memory manager", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_MEMORY_PUBLIC_POSTGRES", connection!);
    registerEmbeddingProvider({
      id: providerId,
      transport: "remote",
      create: async ({ model }) => ({
        provider: {
          id: providerId,
          model,
          embed: async (input) => embedding(input),
          embedBatch: async (inputs) => inputs.map(embedding),
        },
      }),
    });
  });

  beforeAll(async () => {
    root = tempDirs.make("memory-public-postgres-");
    // Raw Vitest workers cannot lend admission for files created by a later native open.
    await fs.mkdir(path.join(root, "state"));
    await fs.writeFile(path.join(root, "state", "openclaw.sqlite"), "", { flag: "wx" });
    workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(workspace, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, "memory", "sapphire.md"),
      "Sapphire navigation records the northern harbor coordinates.\n",
    );
    await fs.writeFile(
      path.join(workspace, "memory", "ruby.md"),
      "Ruby gardening records the southern orchard harvest.\n",
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
    installDatabaseEngineSelection({
      effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
      postgres: { connection: connection!, schemaPrefix: prefix },
    });
    vi.stubEnv("OPENCLAW_MEMORY_PUBLIC_POSTGRES", connection!);
    client = new pg.Client({ connectionString: connection });
    await client.connect();
    await client.query("CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public");
    await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public");
    await client.query("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public");
    admitStateAnchor(root);
    await client.query(`CREATE DATABASE "${keywordDatabase}" TEMPLATE template0`);
    await client.query(`CREATE DATABASE "${noTrigramDatabase}" TEMPLATE template0`);
    await client.query(`CREATE DATABASE "${noUnaccentDatabase}" TEMPLATE template0`);
    for (const database of [keywordDatabase, noTrigramDatabase, noUnaccentDatabase]) {
      const url = new URL(connection!);
      url.pathname = `/${database}`;
      const capabilityClient = new pg.Client({ connectionString: url.href });
      await capabilityClient.connect();
      try {
        if (database !== noUnaccentDatabase) {
          await capabilityClient.query("CREATE EXTENSION unaccent WITH SCHEMA public");
        }
        if (database !== noTrigramDatabase) {
          await capabilityClient.query("CREATE EXTENSION pg_trgm WITH SCHEMA public");
        }
        if (database !== keywordDatabase) {
          await capabilityClient.query("CREATE EXTENSION vector WITH SCHEMA public");
        }
      } finally {
        await capabilityClient.end();
      }
    }
    const { createMemoryRuntime } = await vi.importActual<{
      createMemoryRuntime: (host: MemoryCliHost) => MemoryPluginRuntime;
    }>("../../../extensions/memory-core/runtime-api.js");
    host = {
      runInBackgroundContext: (run) => run(),
      openKeyedStore: <T>(options: OpenKeyedStoreOptions) =>
        createPluginStateKeyedStoreForTests<T>("memory-core", { ...options, env: process.env }),
    };
    runtime = createMemoryRuntime(host);
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
    const cfg = config();
    await fs.writeFile(path.join(root, "openclaw.json"), JSON.stringify(cfg));
    setRuntimeConfigSnapshot(cfg);
    const target = {
      agentId: "main",
      sessionKey: "agent:main:postgres-public-forget",
      sessionId: "postgres-public-forget",
      storePath: resolveDefaultSessionStorePath("main"),
    };
    await upsertSessionEntry({
      ...target,
      entry: { sessionId: target.sessionId, updatedAt: Date.now() },
    });
    await appendSessionTranscriptMessageByIdentity({
      ...target,
      message: {
        role: "user",
        content: "Amethyst remembers the private eastern observatory.",
        timestamp: new Date().toISOString(),
        __openclaw: { senderIsOwner: true },
      },
    });
  });

  it("indexes, searches, forgets, resets, and re-admits through public entry points", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
    const hybrid = await managerFor(config());
    assert(hybrid.sync);
    assert(hybrid.statusAsync);
    await hybrid.sync({ force: true, reason: "test" });
    const lexical = await hybrid.search("sapphire", { lexicalOnly: true, maxResults: 1 });
    expect(lexical).toMatchObject([{ path: "memory/sapphire.md" }]);
    expect(lexical[0]?.snippet).toContain("northern harbor");
    const combined = await hybrid.search("sapphire", { maxResults: 1 });
    expect(combined).toMatchObject([{ path: "memory/sapphire.md" }]);
    expect(await hybrid.search("blue-coordinate", { lexicalOnly: true })).toEqual([]);
    expect(await hybrid.search("blue-coordinate", { maxResults: 1 })).toMatchObject([
      { path: "memory/sapphire.md" },
    ]);
    const indexed = await hybrid.statusAsync();
    expect(indexed).toMatchObject({ files: 3, chunks: 3, fts: { available: true } });
    expect(indexed.vector?.index?.state).toBe("complete");
    await runtime.closeAllMemorySearchManagers?.();

    assert(indexed.dbPath);
    let namespace: string;
    {
      using anchor = openNodeSqliteDatabase(indexed.dbPath, { readOnly: true });
      const row = anchor.prepare("SELECT schema FROM openclaw_engine_anchor").get();
      assert(typeof row?.schema === "string");
      namespace = row.schema;
    }
    const indexRows = async () => ({
      sources: (await client.query(`SELECT * FROM "${namespace}".memory_index_sources ORDER BY id`))
        .rows,
      chunks: (await client.query(`SELECT * FROM "${namespace}".memory_index_chunks ORDER BY id`))
        .rows,
      metadata: (await client.query(`SELECT * FROM "${namespace}".memory_index_meta ORDER BY key`))
        .rows,
      revision: (
        await client.query(`SELECT revision FROM "${namespace}".memory_index_state WHERE id = 1`)
      ).rows,
    });
    const beforeDiagnostic = await indexRows();
    const reopened = await managerFor(config(), "status", "main", true);
    assert(reopened.statusAsync);
    expect(await reopened.statusAsync()).toMatchObject({
      files: 3,
      chunks: 3,
      dirty: false,
      sourceCounts: [
        { source: "memory", files: 2, chunks: 2, eligible: 2, issues: [] },
        { source: "sessions", files: 1, chunks: 1, eligible: 1, issues: [] },
      ],
      fts: { available: true },
      vector: { index: { state: "complete" } },
    });
    await runtime.closeAllMemorySearchManagers?.();
    expect(await indexRows()).toEqual(beforeDiagnostic);

    await runMemoryCommand(["forget", "--agent", "main", "--session", "postgres-public-forget"]);
    const forgotten = await managerFor(config());
    assert(forgotten.statusAsync);
    expect(await forgotten.search("amethyst", { lexicalOnly: true })).toEqual([]);
    expect(await forgotten.search("amethyst")).toEqual([]);
    expect(await forgotten.statusAsync()).toMatchObject({ files: 2, chunks: 2 });
    await runtime.closeAllMemorySearchManagers?.();

    await runMemoryCommand(["reset", "--agent", "main", "--yes"]);
    const reset = await managerFor(config(), "status");
    assert(reset.statusAsync);
    expect(await reset.statusAsync()).toMatchObject({ files: 0, chunks: 0 });
    await runtime.closeAllMemorySearchManagers?.();
    const readmitted = await managerFor(config(), "status");
    assert(readmitted.statusAsync);
    expect(await readmitted.statusAsync()).toMatchObject({ files: 0, chunks: 0 });
  });

  it("serves explicit keyword-only memory without pgvector and rejects semantic bootstrap by name", async () => {
    await selectCapabilityDatabase(keywordDatabase);
    const keywordConfig = config();
    keywordConfig.memory!.search!.provider = "none";
    const keyword = await managerFor(keywordConfig);
    assert(keyword.sync);
    assert(keyword.statusAsync);
    await keyword.sync({ force: true, reason: "test" });
    expect(await keyword.search("sapphire", { maxResults: 1 })).toMatchObject([
      { path: "memory/sapphire.md" },
    ]);
    expect(await keyword.statusAsync()).toMatchObject({
      provider: "none",
      files: 2,
      chunks: 2,
      custom: { searchMode: "fts-only" },
      vector: { enabled: false },
    });
    await runtime.closeAllMemorySearchManagers?.();
    const semantic = await managerFor(config(), "cli", "semantic");
    await expect(semantic.search("sapphire")).rejects.toMatchObject({
      name: "DatabaseSearchCapabilityUnavailableError",
      code: "DATABASE_SEARCH_CAPABILITY_UNAVAILABLE",
      message: expect.stringMatching(/CREATE EXTENSION.*vector/),
    });
  });

  it("refuses configured trigram search without pg_trgm and names the administrator action", async () => {
    await selectCapabilityDatabase(noTrigramDatabase);
    const cfg = config();
    cfg.agents!.entries!.trigram = { workspace };
    cfg.memory!.search!.provider = "none";
    cfg.memory!.search!.store = { fts: { tokenizer: "trigram" } };
    await expect(
      (async () => {
        const manager = await managerFor(cfg, "cli", "trigram");
        await manager.search("sapphire");
      })(),
    ).rejects.toThrow(/PostgreSQL pg_trgm capability unavailable.*CREATE EXTENSION/);
  });

  it("refuses full-text admission without unaccent and names the administrator action", async () => {
    await selectCapabilityDatabase(noUnaccentDatabase);
    const cfg = config();
    cfg.memory!.search!.provider = "none";
    await expect(
      (async () => {
        const manager = await managerFor(cfg);
        await manager.search("sapphire");
      })(),
    ).rejects.toThrow(/PostgreSQL unaccent capability unavailable.*CREATE EXTENSION/);
  });
});
