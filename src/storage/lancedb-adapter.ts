/**
 * ClaWorks LanceDB vector storage adapter.
 *
 * Thin lazy-load wrapper around @lancedb/lancedb for ClaWorks-internal
 * semantic search use cases (agent memory, KB augmentation). The package is
 * an optional dependency — this module is safe to import regardless of whether
 * @lancedb/lancedb is installed.
 *
 * For agent long-term memory in OpenClaw, prefer the bundled `memory-lancedb`
 * plugin. This adapter is for ClaWorks runtime features that need direct
 * vector store access (e.g. Robot-local KB cache, embedding lookup).
 *
 * Usage:
 *   import { createLanceDbAdapter } from "./lancedb-adapter.js";
 *   const db = createLanceDbAdapter({ dataDir: "/data/claworks/vectors" });
 *   const table = await db.openOrCreateTable("kb_chunks", schema, embedFn);
 *   await table.add([{ text: "...", vector: [0.1, 0.2, ...] }]);
 *   const results = await table.search([0.1, 0.2, ...], { limit: 5 });
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** Minimal surface of @lancedb/lancedb that the adapter uses. */
type LanceDbModule = typeof import("@lancedb/lancedb");
type LanceConnection = Awaited<ReturnType<LanceDbModule["connect"]>>;

export type LanceDbAdapterOptions = {
  /**
   * Local directory where LanceDB stores its tables.
   * Defaults to `CLAWORKS_LANCEDB_DATA_DIR` env var, then `~/.claworks/vectors`.
   */
  dataDir?: string;
};

export type VectorRecord = {
  id: string;
  vector: number[];
  text: string;
  metadata?: Record<string, unknown>;
};

export type VectorSearchResult = {
  id: string;
  text: string;
  score: number;
  metadata?: Record<string, unknown>;
};

export type LanceDbTable = {
  add(records: VectorRecord[]): Promise<void>;
  search(queryVector: number[], opts?: { limit?: number }): Promise<VectorSearchResult[]>;
  delete(filter: string): Promise<void>;
  countRows(): Promise<number>;
};

export type LanceDbAdapter = {
  openOrCreateTable(name: string): Promise<LanceDbTable>;
  tableNames(): Promise<string[]>;
  dropTable(name: string): Promise<void>;
};

// ─── Module loader ────────────────────────────────────────────────────────────

function buildMissingPackageError(cause: unknown): Error {
  return new Error(
    [
      "claworks lancedb-adapter: @lancedb/lancedb is not installed or unavailable on this platform.",
      "Install with: pnpm add @lancedb/lancedb",
      "Note: @lancedb/lancedb requires native binaries — verify platform support first.",
      "Alternatively, disable LanceDB-backed features and use SQLite full-text search instead.",
      String(cause),
    ].join(" "),
    { cause },
  );
}

type LoaderDeps = {
  importLanceDb: () => Promise<LanceDbModule>;
};

export function createLanceDbModuleLoader(overrides: Partial<LoaderDeps> = {}): {
  load(): Promise<LanceDbModule>;
} {
  const deps: LoaderDeps = {
    importLanceDb: overrides.importLanceDb ?? (() => import("@lancedb/lancedb")),
  };

  let loadPromise: Promise<LanceDbModule> | null = null;

  return {
    async load(): Promise<LanceDbModule> {
      if (!loadPromise) {
        loadPromise = deps.importLanceDb().catch((err) => {
          loadPromise = null;
          throw buildMissingPackageError(err);
        });
      }
      return loadPromise;
    },
  };
}

const defaultLoader = createLanceDbModuleLoader();

// ─── Adapter factory ──────────────────────────────────────────────────────────

function resolveDataDir(opts: LanceDbAdapterOptions): string {
  return (
    opts.dataDir ??
    process.env["CLAWORKS_LANCEDB_DATA_DIR"] ??
    `${process.env["HOME"] ?? "/tmp"}/.claworks/vectors`
  );
}

/**
 * Wrap a raw LanceDB table into the typed LanceDbTable interface.
 * The raw table API is untyped; we narrow it minimally here.
 */
function wrapTable(rawTable: unknown): LanceDbTable {
  const t = rawTable as {
    add(data: unknown[]): Promise<void>;
    vectorSearch(v: number[]): { limit(n: number): { toArray(): Promise<unknown[]> } };
    delete(filter: string): Promise<void>;
    countRows(): Promise<number>;
  };

  return {
    async add(records: VectorRecord[]): Promise<void> {
      await t.add(records);
    },

    async search(
      queryVector: number[],
      opts: { limit?: number } = {},
    ): Promise<VectorSearchResult[]> {
      const limit = opts.limit ?? 10;
      const raw = (await t.vectorSearch(queryVector).limit(limit).toArray()) as Array<
        Record<string, unknown>
      >;
      return raw.map((row) => ({
        id: String(row["id"] ?? ""),
        text: String(row["text"] ?? ""),
        score: Number(row["_distance"] ?? 0),
        metadata: row["metadata"] as Record<string, unknown> | undefined,
      }));
    },

    async delete(filter: string): Promise<void> {
      await t.delete(filter);
    },

    async countRows(): Promise<number> {
      return t.countRows();
    },
  };
}

/**
 * Create a LanceDB-backed vector store adapter. The underlying connection is
 * initialized lazily on the first operation.
 */
export function createLanceDbAdapter(opts: LanceDbAdapterOptions = {}): LanceDbAdapter {
  const dataDir = resolveDataDir(opts);
  let connPromise: Promise<LanceConnection> | null = null;

  async function connection(): Promise<LanceConnection> {
    if (!connPromise) {
      connPromise = defaultLoader.load().then((lancedb) => lancedb.connect(dataDir));
    }
    return connPromise;
  }

  return {
    async openOrCreateTable(name: string): Promise<LanceDbTable> {
      const conn = await connection();
      const names = await conn.tableNames();
      let rawTable: unknown;
      if (names.includes(name)) {
        rawTable = await conn.openTable(name);
      } else {
        // Create table with an empty schema; records are schema-on-write in LanceDB.
        rawTable = await conn.createTable(name, []);
      }
      return wrapTable(rawTable);
    },

    async tableNames(): Promise<string[]> {
      return (await connection()).tableNames();
    },

    async dropTable(name: string): Promise<void> {
      await (await connection()).dropTable(name);
    },
  };
}

// ─── Singleton convenience ────────────────────────────────────────────────────

let _defaultAdapter: LanceDbAdapter | null = null;

/**
 * Get the process-wide default LanceDB adapter (lazy singleton).
 * Reads `CLAWORKS_LANCEDB_DATA_DIR` from the environment.
 */
export function getDefaultLanceDbAdapter(): LanceDbAdapter {
  _defaultAdapter ??= createLanceDbAdapter();
  return _defaultAdapter;
}
