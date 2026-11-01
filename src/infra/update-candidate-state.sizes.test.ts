import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as commands from "../process/exec.js";
import { readUpdateStateDatabaseSizes } from "./update-candidate-state.sizes.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  }),
);

async function fixture(name = "a".repeat(140)) {
  const root = await fs.realpath(dirs.make("inventory-batches-"));
  const file = path.join(root, name);
  await fs.writeFile(file, "source");
  await fs.writeFile(`${file}-wal`, "wal");
  return {
    file,
    options: { nodeRunner: process.execPath, sourceEnv: {}, stagingRoot: root },
  };
}

it.each([
  ["ASCII", "a".repeat(140)],
  ["UTF-8", "目录😀".repeat(18)],
  ["escaped", process.platform === "win32" ? "a".repeat(140) : '\\"'.repeat(70)],
])("returns a 12,000-entry %s inventory through the capped real child", async (_kind, name) => {
  const { file, options } = await fixture(name);
  const other = path.join(options.stagingRoot, "second");
  await fs.writeFile(other, "second");
  const files = Array.from({ length: 12_000 }, (_, i) => (i % 3 === 0 ? other : file));
  files.splice(6000, 0, path.join(options.stagingRoot, "missing"));
  const result = await readUpdateStateDatabaseSizes(files, options);
  expect(result).toEqual(
    Array.from({ length: 12_000 }, (_, i) => ({
      path: i % 3 === 0 ? other : file,
      sizeBytes: i % 3 === 0 ? 6n : 9n,
    })),
  );
});

it("rejects without partial results or another child when canceled during a later batch", async () => {
  const { file, options } = await fixture();
  const controller = new AbortController();
  const run = commands.runUtf8CommandWithTimeout;
  const launches = vi
    .spyOn(commands, "runUtf8CommandWithTimeout")
    .mockImplementation((argv, opts) => {
      if (typeof opts === "number") {
        throw new Error("Expected inventory options");
      }
      const second = launches.mock.calls.length === 2;
      return run(argv, {
        ...opts,
        onOutputChunk: (chunk, stream) => {
          opts.onOutputChunk?.(chunk, stream);
          if (second) {
            controller.abort(new Error("inventory canceled"));
          }
        },
      });
    });
  await expect(
    readUpdateStateDatabaseSizes(Array(12_000).fill(file), {
      ...options,
      signal: controller.signal,
    }),
  ).rejects.toThrow("inventory canceled");
  expect(launches).toHaveBeenCalledTimes(2);
});

it("shares an aggregate deadline and stops launching when it expires", async () => {
  const { file, options } = await fixture();
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const timeouts: number[] = [];
  const run = commands.runUtf8CommandWithTimeout;
  vi.spyOn(commands, "runUtf8CommandWithTimeout").mockImplementation(async (argv, opts) => {
    if (typeof opts === "number" || opts.timeoutMs === undefined) {
      throw new Error("Expected a bounded inventory child");
    }
    timeouts.push(opts.timeoutMs);
    const result = await run(argv, opts);
    now += timeouts.length === 1 ? opts.timeoutMs - 2000 : opts.timeoutMs + 1;
    return result;
  });
  await expect(readUpdateStateDatabaseSizes(Array(12_000).fill(file), options)).rejects.toThrow(
    /deadline exceeded/,
  );
  expect(timeouts).toHaveLength(2);
  expect(timeouts[1]).toBe(2000);
  expect(timeouts[0]).toBeGreaterThan(timeouts[1]!);
});
