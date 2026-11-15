import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isPrExemptRuntimeTestFile } from "../../scripts/lib/ci-proof-test-inventory.mts";
import { createWindowsTestShards } from "../../scripts/lib/ci-windows-test-plan.mts";
import { resolveVitestPretestBuildMode } from "../../scripts/lib/vitest-build-prerequisites.mts";

const command = "node scripts/test-projects.mts";
const compareFiles = (a: string, b: string) => a.localeCompare(b);
const targets = (shards: ReturnType<typeof createWindowsTestShards>) =>
  shards.flatMap((shard) => shard.targets);

function packageScripts(files = ["src/first.test.ts", "src/second.test.ts"], first?: string) {
  const middle = Math.ceil(files.length / 2);
  return {
    "test:windows:ci:1": first ?? `${command} ${files.slice(0, middle).join(" ")}`,
    "test:windows:ci:2": `${command} ${files.slice(middle).join(" ")}`,
  };
}

function expectPlacement(scripts: Record<string, string>, files: string[], budget: number) {
  const shards = createWindowsTestShards(scripts);
  expect(targets(shards).toSorted(compareFiles)).toEqual(files.toSorted(compareFiles));
  expect(shards.every((shard) => shard.predicted_seconds < budget)).toBe(true);
  expect(createWindowsTestShards(packageScripts(files.toReversed()))).toEqual(shards);
  return shards;
}

describe("Windows CI whole-file placement", () => {
  it("covers the package-owned native inventory exactly once within five budgeted jobs", () => {
    const { scripts } = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    const inventory = [1, 2].flatMap((part) =>
      scripts[`test:windows:ci:${part}`].slice(command.length + 1).split(" "),
    );
    // Includes the unmeasured managed-handoff regression's 3s fallback envelope.
    const shards = expectPlacement(scripts, inventory, 432);
    expect(shards).toHaveLength(5);
    expect(
      shards.filter(
        (shard) =>
          resolveVitestPretestBuildMode([{ includePatterns: shard.targets }]) !== undefined,
      ),
    ).toHaveLength(1);
    const pr = createWindowsTestShards(scripts, { includePrExemptRuntimeTests: false });
    expect(targets(pr).toSorted(compareFiles)).toEqual(
      inventory.filter((file: string) => !isPrExemptRuntimeTestFile(file)).toSorted(compareFiles),
    );
    const changed = inventory.find((file: string) => isPrExemptRuntimeTestFile(file));
    expect(changed).toBeDefined();
    const changedShards = createWindowsTestShards(scripts, {
      includePrExemptRuntimeTests: false,
      changedPaths: [changed],
    });
    expect(targets(changedShards)).toContain(changed);
  });

  const filesIn = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, index) => `${prefix}${index}.test.ts`);
  it.each([
    { files: filesIn("src/native/case-", 24), together: true },
    {
      files: [
        "extensions/msteams/src/messenger.test.ts",
        ...filesIn("extensions/msteams/src/rounding-", 101),
      ],
      together: false,
    },
  ])(
    "places every file at the budget boundary regardless of input order %#",
    ({ files, together }) => {
      const shards = expectPlacement(packageScripts(files), files, 420);
      if (together) {
        expect(shards).toHaveLength(1);
      }
    },
  );

  it.each([
    { "test:windows:ci:1": `${command} src/first.test.ts` },
    packageScripts(
      undefined,
      "node --import ./scripts/tsx.mjs scripts/test-projects.mts src/first.test.ts",
    ),
    packageScripts(["src/repeated.test.ts", "src/repeated.test.ts"]),
    packageScripts(["src/first.test.ts", "src/*.test.ts"]),
  ])("refuses an incomplete or filtered package inventory", (scripts) => {
    expect(() => createWindowsTestShards(scripts)).toThrow(/Windows CI/u);
  });
});
