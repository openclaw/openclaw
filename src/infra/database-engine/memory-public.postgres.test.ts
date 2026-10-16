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
const providerId = "postgres-memory-fixture";
let root: string;
let keywordRoot: string | undefined;
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
      if (keywordRoot) {
        await cleanupSessionStateForTest({ stateDir: keywordRoot });
      }
      const schemas = await client.query<{ nspname: string }>(
        "SELECT nspname FROM pg_namespace WHERE left(nspname, $1) = $2",
        [prefix.length + 1, `${prefix}_`],
      );
      for (const { nspname } of schemas.rows) {
        await client.query(`DROP SCHEMA "${nspname.replaceAll('"', '""')}" CASCADE`);
      }
      await client.query(`DROP DATABASE IF EXISTS "${keywordDatabase}" WITH (FORCE)`);
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
    plugins: { enabled: false },
    agents: { entries: { main: { workspace }, semantic: { workspace } } },
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
) {
  setRuntimeConfigSnapshot(cfg);
  const result = await runtime.getMemorySearchManager({ cfg, agentId, purpose });
  assert(result.manager, result.error ?? "Expected public PostgreSQL memory manager");
  return result.manager;
}

async function runMemoryCommand(args: string[]) {
  const { registerMemoryCli } = await vi.importActual<{
    registerMemoryCli: (program: Command, host: MemoryCliHost) => void;
  }>("../../../extensions/memory-core/cli.js");
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

describe.skipIf(!connection)("public PostgreSQL memory manager", () => {
  beforeEach(() => {
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
    client = new pg.Client({ connectionString: connection });
    await client.connect();
    await client.query("CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public");
    await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public");
    await client.query("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public");
    admitStateAnchor(root);
    await client.query(`CREATE DATABASE "${keywordDatabase}"`);
    const keywordUrl = new URL(connection!);
    keywordUrl.pathname = `/${keywordDatabase}`;
    const keywordClient = new pg.Client({ connectionString: keywordUrl.href });
    await keywordClient.connect();
    try {
      await keywordClient.query("CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public");
    } finally {
      await keywordClient.end();
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

    const reopened = await managerFor(config(), "status");
    assert(reopened.statusAsync);
    expect(await reopened.statusAsync()).toMatchObject({
      files: 3,
      chunks: 3,
      fts: { available: true },
      vector: { index: { state: "complete" } },
    });
    await runtime.closeAllMemorySearchManagers?.();

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
    await runtime.closeAllMemorySearchManagers?.();
    await cleanupSessionStateForTest({ stateDir: root });
    keywordRoot = tempDirs.make("memory-public-keyword-postgres-");
    await fs.mkdir(path.join(keywordRoot, "state"));
    await fs.writeFile(path.join(keywordRoot, "state", "openclaw.sqlite"), "", { flag: "wx" });
    vi.stubEnv("OPENCLAW_STATE_DIR", keywordRoot);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(keywordRoot, "openclaw.json"));
    const keywordUrl = new URL(connection!);
    keywordUrl.pathname = `/${keywordDatabase}`;
    resetDatabaseEngineSelectionForTest();
    installDatabaseEngineSelection({
      effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
      postgres: { connection: keywordUrl.href, schemaPrefix: prefix },
    });
    admitStateAnchor(keywordRoot);
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
});
