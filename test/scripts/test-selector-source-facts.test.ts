import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readTestSelectorSourceFacts } from "../../scripts/lib/test-selector-source-facts.mts";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));

const spawn = vi.mocked(spawnSync);
const jitAssertion = "# Check failed: jit_page.has_value().";
const crashedScan: SpawnSyncReturns<string> = {
  pid: 12345,
  status: null,
  signal: "SIGTRAP",
  stdout: "partial, invalid scan output",
  stderr: jitAssertion,
  output: [],
};
const files = [{ file: "source.ts", parseImports: true }];

beforeEach(() => spawn.mockReset());

describe("test selector native crash recovery", () => {
  it("rescans without workers and preserves complete facts and request order", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "openclaw-source-scan-recovery-"));
    try {
      writeFileSync(path.join(cwd, "first.ts"), 'import "./first.js"; const needle: number = 1;');
      writeFileSync(path.join(cwd, "last.ts"), 'import "./last.js"; const needle: number = 2;');
      const hook = path.join(cwd, "forbid-workers.mjs");
      writeFileSync(
        hook,
        `import os from "node:os";
import workers from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";
os.availableParallelism = () => 2;
workers.Worker = class { constructor() { throw new Error("Recovery started a scan worker"); } };
syncBuiltinESMExports();`,
      );
      const actual =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      spawn
        .mockReturnValueOnce(crashedScan)
        .mockImplementationOnce((command, args, options) =>
          actual.spawnSync(command, ["--import", hook, ...(args ?? [])], options),
        );
      // This inventory normally starts workers. Missing rows must not shift
      // identity when the failed child's partial output is discarded.
      const inventory = Array.from({ length: 600 }, (_, index) => ({
        file: ["first.ts", "missing.ts", "last.ts"][index % 3]!,
        parseImports: true,
      }));
      expect(
        readTestSelectorSourceFacts(cwd, inventory, ["needle"], 1024 * 1024, {
          matchingOnly: true,
        }),
      ).toEqual(
        inventory
          .filter(({ file }) => file !== "missing.ts")
          .map(({ file }) => ({
            file,
            imports: [`./${file.replace(".ts", ".js")}`],
            mocks: [],
            typeOnlyImports: [],
            matches: ["needle"],
            references: ["needle"],
          })),
      );
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each([
    { status: 1, signal: null, stderr: "SyntaxError: invalid source" },
    { signal: "SIGTERM", stderr: jitAssertion },
    { signal: "SIGTRAP", stderr: "# Check failed: unrelated assertion" },
    { error: new Error("output overflow"), stderr: jitAssertion },
  ] as const)("does not retry ordinary failures or cancellation (%j)", (failure) => {
    spawn.mockReturnValue({ ...crashedScan, ...failure });
    expect(() => readTestSelectorSourceFacts(process.cwd(), files, [], 1024)).toThrow(
      "Test selector source scan failed",
    );
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("fails after one unsuccessful recovery attempt", () => {
    spawn.mockReturnValue(crashedScan);
    expect(() => readTestSelectorSourceFacts(process.cwd(), files, [], 1024)).toThrow(jitAssertion);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("still rejects an incomplete result from recovery", () => {
    spawn
      .mockReturnValueOnce(crashedScan)
      .mockReturnValueOnce({ ...crashedScan, status: 0, signal: null, stderr: "", stdout: "[]" });
    expect(() => readTestSelectorSourceFacts(process.cwd(), files, [], 1024)).toThrow(
      "Invalid test selector source scan row count",
    );
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});
