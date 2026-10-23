import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readTestSelectorSourceFacts } from "../../scripts/lib/test-selector-source-facts.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));

const spawn = vi.mocked(spawnSync);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
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
const emptyFacts = { imports: [], mocks: [], typeOnlyImports: [], matches: [], references: [] };
const scan = () => readTestSelectorSourceFacts(process.cwd(), files, [], 1024);
function successfulScan(stdout: string): SpawnSyncReturns<string> {
  return { ...crashedScan, status: 0, signal: null, stderr: "", stdout };
}
function expectScanFailure(message: string, calls: number) {
  expect(scan).toThrow(message);
  expect(spawn).toHaveBeenCalledTimes(calls);
}

beforeEach(() => spawn.mockReset());

it("separates erased leading TSX imports from runtime and uncertain dependencies", async () => {
  const cases = [
    {
      source: `// import type { Fake } from "./comment.js";
import type { Value } from "./types.js";
import { value, type Shape } from "./runtime.js";
import type from "./default-type.js";
import { type Shape } from "./side-effect.js";
export const view = <div>{value} ·</div>;`,
      erased: ["./types.js"],
      retained: ["./runtime.js", "./default-type.js", "./side-effect.js"],
    },
    ...[
      'import type { Value } from "./types.js"; export const view = <div>{import("./types.js")}</div>;',
      'import type { Value } from "./types.js"; export const view = <div> // text {import("./types.js")} </div>;',
      String.raw`import type { Value } from "./types.js"; export const view = <div> // text {import('./ty\u0070es.js')} </div>;`,
      String.raw`import type { Value } from "./types.js"; export const view = <div>{requ\u0069re('./types.js')}</div>;`,
      'import type { Value } from "./types.js"; export const view = <div> // text {import(/* load */ "./types.js")} </div>;',
      'import type { Value } from "./types.js"; export const view = <div> // text\n</div>; export { value } from/* load */ "./types.js";',
      'import type { Value } from "./types.js"; export const view = <div />; import "./types.js";',
      '"import type { Fake } from \'./types.js\'"; import type { Value } from "./types.js"; export const view = <div />;',
      '"import"\nimport type { Value } from "./types.js"; export const view = <div />;',
      'export const view = <div>import type Value from "./types.js"</div>; import("./types.js");',
    ].map((source) => ({ source, erased: [], retained: ["./types.js"] })),
  ];
  const cwd = tempDirs.make("openclaw-tsx-import-facts-");
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  spawn.mockImplementationOnce((command, args, options) =>
    actual.spawnSync(command, args, options),
  );
  const inventory = cases.map(({ source }, index) => {
    const file = `${index}.tsx`;
    writeFileSync(path.join(cwd, file), source);
    return { file, parseImports: true };
  });
  const facts = readTestSelectorSourceFacts(cwd, inventory, [], 1024 * 1024);
  for (const [index, { erased, retained }] of cases.entries()) {
    expect(facts[index]?.typeOnlyImports, inventory[index]?.file).toEqual(erased);
    const runtime = facts[index]?.imports.filter(
      (specifier) => !facts[index]?.typeOnlyImports.includes(specifier),
    );
    expect(runtime, inventory[index]?.file).toEqual(expect.arrayContaining(retained));
  }
});

describe("test selector native crash recovery", () => {
  it.each([null, [["worker"]], [["worker", 1]]])(
    "rejects invalid runtime-worker export facts: %j",
    (workerExports) => {
      spawn.mockReturnValue(successfulScan(JSON.stringify([{ ...emptyFacts, workerExports }])));
      expect(scan).toThrow("Invalid runtime worker exports");
    },
  );

  it("rescans without workers and preserves complete facts and request order", async () => {
    const cwd = tempDirs.make("openclaw-source-scan-recovery-");
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
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
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
          workerExports: [],
          typeOnlyImports: [],
          matches: ["needle"],
          references: ["needle"],
        })),
    );
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it.each([
    { status: 1, signal: null, stderr: "SyntaxError: invalid source" },
    { signal: "SIGTERM", stderr: jitAssertion },
    { signal: "SIGTRAP", stderr: "# Check failed: unrelated assertion" },
    { error: new Error("output overflow"), stderr: jitAssertion },
  ] as const)("does not retry ordinary failures or cancellation (%j)", (failure) => {
    spawn.mockReturnValue({ ...crashedScan, ...failure });
    expectScanFailure("Test selector source scan failed", 1);
  });

  it("fails after one unsuccessful recovery attempt", () => {
    spawn.mockReturnValue(crashedScan);
    expectScanFailure(jitAssertion, 2);
  });

  it("still rejects an incomplete result from recovery", () => {
    spawn.mockReturnValueOnce(crashedScan).mockReturnValueOnce(successfulScan("[]"));
    expectScanFailure("Invalid test selector source scan row count", 2);
  });
});
