import * as childProcess from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { ensureSqliteLibrarySelected } from "../bun-sqlite-library.js";
import { runVectorKnnInSubprocess } from "./sqlite-vector-subprocess.js";

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
