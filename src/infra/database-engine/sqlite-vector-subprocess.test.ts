import * as childProcess from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { ensureSqliteLibrarySelected } from "../bun-sqlite-library.js";
import { readChildRuntimeViability } from "../child-runtime-viability.js";
import { runVectorKnnInSubprocess } from "./sqlite-vector-subprocess.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

it.skipIf(process.platform === "win32")(
  "classifies a replaced runtime that cannot be executed before vector worker startup",
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-vector-runtime-"));
    const executable = process.execPath;
    try {
      process.execPath = path.join(directory, "node");
      await fs.writeFile(process.execPath, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
      const run = () =>
        runVectorKnnInSubprocess({
          databasePath: "fixture:runtime-permission",
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
      await expect(run()).rejects.toMatchObject({
        code: "NODE_RUNTIME_UNAVAILABLE",
        message: expect.stringContaining("Restart the Gateway."),
      });
      expect(readChildRuntimeViability().available).toBe(false);
      const launches = vi.mocked(childProcess.spawn).mock.calls.length;
      await expect(run()).rejects.toMatchObject({ code: "NODE_RUNTIME_UNAVAILABLE" });
      expect(vi.mocked(childProcess.spawn)).toHaveBeenCalledTimes(launches);
    } finally {
      process.execPath = executable;
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
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
