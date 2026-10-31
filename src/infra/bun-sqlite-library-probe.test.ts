import fs from "node:fs";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { mockBunSqliteNativeBoundary } from "./bun-sqlite-library.test-support.js";

const { probeBunSqliteLibrary } = await import("./bun-sqlite-library-probe.js");

const directories = useAutoCleanupTempDirTracker(afterEach);

function fixture() {
  const native = mockBunSqliteNativeBoundary();
  const directory = directories.make("sqlite-library-probe-");
  vi.stubEnv("TMPDIR", directory);
  return { ...native, directory };
}

it("probes with the current runtime and no inherited startup hooks, then removes its program", () => {
  const f = fixture();
  vi.stubEnv("NODE_OPTIONS", "--require=/unrelated/operator-preload.cjs");
  vi.stubEnv("BUN_OPTIONS", "--preload=/unrelated/operator-preload.mjs");
  vi.stubEnv("OPENCLAW_SQLITE_LIBRARY", "/unrelated/library.dylib");
  const candidate = "/sqlite path/'\";invalid-source.dylib";
  expect(probeBunSqliteLibrary(candidate)).toEqual({
    version: "3.53.4",
    extensionLoadingSupported: true,
  });
  const [command, args, options] = expectDefined(f.spawn.mock.calls[0], "probe launch");
  expect(command).toBe(process.execPath);
  expect(args.at(-1)).toBe(candidate);
  expect(options.env).toMatchObject({ TMPDIR: f.directory });
  for (const key of ["NODE_OPTIONS", "BUN_OPTIONS", "OPENCLAW_SQLITE_LIBRARY"]) {
    expect(options.env).not.toHaveProperty(key);
  }
  expect(options).toMatchObject({ timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 4_096 });
  expect(fs.readdirSync(f.directory)).toEqual([]);
});

it.each([
  "not JSON",
  "null",
  "[]",
  JSON.stringify({ version: "3.53.4", extensionLoadingSupported: true }),
  JSON.stringify({ protocol: 1, version: "3.53.4", extensionLoadingSupported: "true" }),
  JSON.stringify({ protocol: 1, version: "3".repeat(65), extensionLoadingSupported: true }),
])("rejects malformed child facts and removes its program (%s)", (stdout) => {
  const f = fixture();
  f.spawn.mockReturnValueOnce({ status: 0, stdout });
  expect(() => probeBunSqliteLibrary("/sqlite.dylib")).toThrow("invalid output");
  expect(fs.readdirSync(f.directory)).toEqual([]);
});

it.each([
  {
    result: { error: new Error("probe timeout"), stdout: "", status: null },
    message: "probe timeout",
  },
  {
    result: {
      status: 1,
      stdout: JSON.stringify({ protocol: 1, error: "SQLite already loaded" }),
    },
    message: "SQLite already loaded",
  },
])("reports child failure and removes its program ($message)", ({ result, message }) => {
  const f = fixture();
  f.spawn.mockReturnValueOnce(result);
  expect(() => probeBunSqliteLibrary("/sqlite.dylib")).toThrow(message);
  expect(fs.readdirSync(f.directory)).toEqual([]);
});
