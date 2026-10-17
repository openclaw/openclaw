import * as childProcess from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { ensureSqliteLibrarySelected } from "../bun-sqlite-library.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { runVectorKnnInSubprocess } from "./sqlite-vector-subprocess.js";
import { matchesVectorRow } from "./vector-contract.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock("../bun-sqlite-library.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bun-sqlite-library.js")>();
  return { ...actual, ensureSqliteLibrarySelected: vi.fn(actual.ensureSqliteLibrarySelected) };
});

it("forwards a discovered SQLite library through stdin without inheriting its environment", async () => {
  const sqliteLibraryPath = "/synthetic/sqlite/libsqlite3.dylib";
  vi.stubEnv("OPENCLAW_SQLITE_LIBRARY", sqliteLibraryPath);
  vi.mocked(ensureSqliteLibrarySelected).mockReturnValueOnce({
    source: "discovered",
    path: sqliteLibraryPath,
    version: "3.53.4",
    extensionLoadingSupported: true,
  });
  const { spawn } =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL(
          "../../../extensions/memory-core/src/memory/fixtures/manager-search-knn-child.fixture.mjs",
          import.meta.url,
        ),
      ),
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const write = vi.spyOn(child.stdin, "write");
  vi.mocked(childProcess.spawn).mockReturnValueOnce(child);
  try {
    await runVectorKnnInSubprocess({
      databasePath: "fixture:ok",
      request: {
        query: { sql: "", parameters: [] },
        scopeCount: { sql: "", parameters: [] },
        vectorTable: "vectors",
        limit: 1,
        candidateParameter: 0,
        rowShape: {},
      },
      isRow: (_row): _row is never => false,
    });
    expect(JSON.parse(String(write.mock.calls[0]![0]))).toHaveProperty(
      "sqliteLibraryPath",
      sqliteLibraryPath,
    );
    expect(vi.mocked(childProcess.spawn).mock.calls[0]![2]?.env).not.toHaveProperty(
      "OPENCLAW_SQLITE_LIBRARY",
    );
  } finally {
    const closed = once(child, "close");
    child.kill("SIGKILL");
    await closed;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

it("budgets the page cache on the child's per-request read-only connection", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-vector-knn-"));
  const databasePath = path.join(directory, "memory.sqlite");
  const seed = openNodeSqliteDatabase(databasePath, {});
  seed.exec("CREATE TABLE memory_index_chunks_vec (id TEXT PRIMARY KEY)");
  seed.close();
  const rowShape = { cache_size: "number" } as const;
  try {
    // The child runs the plan's statement verbatim, so the statement can read back the
    // pragma that connection applied before the KNN query.
    await expect(
      runVectorKnnInSubprocess({
        databasePath,
        request: {
          query: { sql: "SELECT cache_size FROM pragma_cache_size WHERE ? > 0", parameters: [0] },
          scopeCount: { sql: "SELECT 0 AS count", parameters: [] },
          vectorTable: "memory_index_chunks_vec",
          limit: 1,
          candidateParameter: 0,
          rowShape,
        },
        isRow: (row): row is { cache_size: number } => matchesVectorRow(row, rowShape),
      }),
    ).resolves.toEqual({ rows: [{ cache_size: -65536 }], fallbackScanRequired: false });
  } finally {
    for (const result of vi.mocked(childProcess.spawn).mock.results) {
      if (result.type !== "return") {
        continue;
      }
      const child = result.value;
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close");
        child.kill("SIGKILL");
        await closed;
      }
    }
    fs.rmSync(directory, { force: true, recursive: true });
  }
});
