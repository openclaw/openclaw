import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stageStandaloneSqlite } from "../../scripts/lib/bun-standalone-sqlite.mjs";

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: run }));

const temporary: string[] = [];
beforeEach(() => run.mockReset());
afterEach(() => {
  for (const directory of temporary.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-sqlite-"));
  temporary.push(root);
  const repoRoot = path.join(root, "repo");
  const runtimeRoot = path.join(root, "runtime");
  fs.mkdirSync(path.join(repoRoot, "scripts/lib"), { recursive: true });
  fs.mkdirSync(runtimeRoot);
  fs.writeFileSync(
    path.join(repoRoot, "scripts/lib/sqlite-macos.json"),
    JSON.stringify({ version: "3.53.4", url: "https://sqlite.org/source.zip", sha256: "archive" }),
  );
  return { repoRoot, runtimeRoot, bunExecutable: "/compiler/bun", arch: "arm64" as const };
}

function prepare(probe = { version: "3.53.4", extensionLoadingSupported: true }) {
  run.mockImplementation((command: string, args: string[]) => {
    if (command === "/bin/bash") {
      const runtimeRoot = args[2];
      assert.ok(runtimeRoot);
      fs.mkdirSync(path.join(runtimeRoot, "lib"), { recursive: true });
      fs.writeFileSync(path.join(runtimeRoot, "lib/libsqlite3.dylib"), "sqlite fixture");
    }
    return {
      status: 0,
      stdout: JSON.stringify({ ...probe, compileOptions: ["ENABLE_FTS5", "THREADSAFE=1"] }),
    };
  });
}

describe("standalone SQLite staging", () => {
  it("retains the app builder's library path and records the measured library identity", () => {
    const options = fixture();
    prepare();
    const result = stageStandaloneSqlite({ ...options, platform: "darwin" });
    expect(run).toHaveBeenCalledWith(
      "/bin/bash",
      [path.join(options.repoRoot, "scripts/build-mac-sqlite.sh"), "arm64", options.runtimeRoot],
      { encoding: "utf8" },
    );
    expect(result).toEqual({
      files: [
        {
          source: "lib/libsqlite3.dylib",
          destination: "lib/libsqlite3.dylib",
          category: "nativeLibraries",
        },
      ],
      manifest: {
        source: "bundled",
        path: "lib/libsqlite3.dylib",
        version: "3.53.4",
        extensionLoadingSupported: true,
        compileOptions: ["ENABLE_FTS5", "THREADSAFE=1"],
        sha256: "ee60932df9287c2b5eaf6a9c2e720697d1fc6f01031e1caf61928bacae7cc004",
        sourceArchive: { url: "https://sqlite.org/source.zip", sha256: "archive" },
        license: "public-domain",
      },
    });
    expect(fs.readFileSync(path.join(options.runtimeRoot, result.manifest.path), "utf8")).toBe(
      "sqlite fixture",
    );
  });

  it.each([
    { version: "3.51.2", extensionLoadingSupported: true, error: "WAL safety floor" },
    { version: "3.53.4", extensionLoadingSupported: false, error: "SQLITE_OMIT_LOAD_EXTENSION" },
    { version: "3.54.0", extensionLoadingSupported: true, error: "differs from pin" },
  ])("rejects an unusable or unexpected compiled library: $error", ({ error, ...probe }) => {
    prepare(probe);
    expect(() => stageStandaloneSqlite({ ...fixture(), platform: "darwin" })).toThrow(error);
  });

  it("qualifies Linux's embedded SQLite without adding a host library", () => {
    prepare();
    const options = fixture();
    const result = stageStandaloneSqlite({ ...options, platform: "linux" });
    expect(result.files).toEqual([]);
    expect(result.manifest).toEqual({
      source: "bun",
      version: "3.53.4",
      extensionLoadingSupported: true,
      compileOptions: ["ENABLE_FTS5", "THREADSAFE=1"],
      license: "public-domain",
    });
    expect(fs.readdirSync(options.runtimeRoot)).toEqual([]);
  });
});
