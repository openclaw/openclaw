import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createWindowsTestShards } from "../../scripts/lib/ci-windows-test-plan.mts";
import { resolveVitestPretestBuildMode } from "../../scripts/lib/vitest-build-prerequisites.mts";

const command = "node --import ./scripts/tsx.mjs scripts/test-projects.mts";

function packageScripts(files: string[]) {
  const middle = Math.ceil(files.length / 2);
  return {
    "test:windows:ci:1": `${command} ${files.slice(0, middle).join(" ")}`,
    "test:windows:ci:2": `${command} ${files.slice(middle).join(" ")}`,
  };
}

describe("Windows CI whole-file placement", () => {
  it("covers the package-owned native inventory exactly once within five budgeted jobs", () => {
    const { scripts } = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    const inventory = [1, 2].flatMap((part) =>
      scripts[`test:windows:ci:${part}`].slice(command.length + 1).split(" "),
    );
    const shards = createWindowsTestShards(scripts);
    expect(shards).toHaveLength(4);
    const compareFiles = (a: string, b: string) => a.localeCompare(b);
    expect(shards.flatMap((shard) => shard.targets).toSorted(compareFiles)).toEqual(
      inventory.toSorted(compareFiles),
    );
    expect(shards.every((shard) => shard.predicted_seconds < 420)).toBe(true);
    expect(
      shards.filter(
        (shard) =>
          resolveVitestPretestBuildMode([{ includePatterns: shard.targets }]) !== undefined,
      ),
    ).toHaveLength(1);
    expect(createWindowsTestShards(packageScripts(inventory.toReversed()))).toEqual(shards);
    expect(
      shards.filter((shard) =>
        shard.targets.includes("test/scripts/vitest-worker-artifacts.test.ts"),
      ),
    ).toHaveLength(1);
  });

  it("keeps an unmeasured project together regardless of inventory ordering", () => {
    const files = Array.from({ length: 24 }, (_, index) => `src/native/case-${index}.test.ts`);
    const forward = createWindowsTestShards(packageScripts(files));
    expect(forward).toHaveLength(1);
    expect(forward.flatMap((shard) => shard.targets).toSorted()).toEqual(files.toSorted());
    expect(createWindowsTestShards(packageScripts(files.toReversed()))).toEqual(forward);
  });

  it("splits a project whose rounded prediction reaches the budget", () => {
    const files = [
      "extensions/msteams/src/messenger.test.ts",
      ...Array.from(
        { length: 101 },
        (_, index) => `extensions/msteams/src/rounding-${index}.test.ts`,
      ),
    ];
    const shards = createWindowsTestShards(packageScripts(files));
    expect(shards.flatMap((shard) => shard.targets).toSorted()).toEqual(files.toSorted());
    expect(shards.every((shard) => shard.predicted_seconds < 420)).toBe(true);
  });

  it.each([
    { "test:windows:ci:1": `${command} src/first.test.ts` },
    packageScripts(["src/repeated.test.ts", "src/repeated.test.ts"]),
    packageScripts(["src/first.test.ts", "src/*.test.ts"]),
    packageScripts(["src/first.test.ts", "src/second.test.ts --testNamePattern=partial"]),
  ])("refuses an incomplete or filtered package inventory", (scripts) => {
    expect(() => createWindowsTestShards(scripts)).toThrow(/Windows CI/u);
  });
});
