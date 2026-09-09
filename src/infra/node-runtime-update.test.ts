import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { resolveUpdatedNodeRuntime } from "../../node-runtime-update.mjs";
import { withTempDir } from "../test-utils/temp-dir.js";

const mocks = vi.hoisted(() => ({
  exists: vi.fn<(value: string) => boolean>(),
  spawn:
    vi.fn<
      (
        file: string,
        args: string[],
        options: SpawnSyncOptionsWithStringEncoding,
      ) => SpawnSyncReturns<string>
    >(),
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: mocks.exists,
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: mocks.spawn,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it.each([
  ["healthy supported", "26.8.1", true],
  ["broken supported", "26.8.1", false],
  ["lossless vendor", "24.15.0+vendor.1", true],
] as const)("validates a %s cached runtime", async (_label, version, lossless) => {
  vi.stubEnv("CI", "1");
  vi.stubEnv("OPENCLAW_NODE_UPDATE_RESPAWNED", "");
  vi.stubEnv("NODE_OPTIONS", undefined);
  const childProcess =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  await withTempDir("openclaw-node-recovery-", async (home) => {
    const nodeRoot = path.join(home, ".openclaw", "tools", "cli-node", "tools", "node");
    const candidate =
      process.platform === "win32"
        ? path.join(nodeRoot, "node.exe")
        : path.join(nodeRoot, "bin", "node");
    const preload = path.join(home, "binding.mjs");
    await fs.writeFile(
      preload,
      `
      import { DatabaseSync } from "node:sqlite";
      Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} });
      if (!${lossless}) {
        const prepare = DatabaseSync.prototype.prepare;
        DatabaseSync.prototype.prepare = function(sql) {
          const statement = prepare.call(this, sql);
          const get = statement.get;
          statement.get = function(...args) {
            const row = get.apply(this, args);
            if (row) for (const key of Object.keys(row)) {
              if (typeof row[key] === "string") row[key] = row[key].split("\\0")[0];
            }
            return row;
          };
          return statement;
        };
      }
    `,
    );
    mocks.exists.mockImplementation((value) => value === candidate);
    mocks.spawn.mockImplementation((_file, args, options) =>
      childProcess.spawnSync(
        process.execPath,
        ["--import", pathToFileURL(preload).href, ...args],
        options,
      ),
    );

    expect(await resolveUpdatedNodeRuntime(home)).toBe(lossless ? candidate : null);
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(mocks.spawn.mock.calls[0]?.[2].timeout).toBe(10_000);
    const result = mocks.spawn.mock.results[0];
    if (result?.type !== "return") {
      throw new Error("Runtime probe did not return");
    }
    expect(JSON.parse(result.value.stdout)).toMatchObject({
      version,
      probe: { available: true, text: lossless, blob: true, json: true },
    });
  });
});
