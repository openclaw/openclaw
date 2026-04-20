import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createChannelContractTestShards } from "../../scripts/lib/channel-contract-test-plan.mjs";

function listContractTests(rootDir = "src/channels/plugins/contracts"): string[] {
  if (!existsSync(rootDir)) {
    return [];
  }

  return readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => join(rootDir, entry.name).replaceAll("\\", "/"))
    .toSorted((a, b) => a.localeCompare(b));
}

describe("scripts/lib/channel-contract-test-plan.mjs", () => {
  it("splits channel contracts into focused shards", () => {
    expect(
      createChannelContractTestShards().map((shard) => ({
        checkName: shard.checkName,
        runtime: shard.runtime,
        task: shard.task,
      })),
    ).toEqual([
      {
        checkName: "checks-fast-contracts-channels-registry-a",
        runtime: "node",
        task: "contracts-channels",
      },
      {
        checkName: "checks-fast-contracts-channels-registry-b",
        runtime: "node",
        task: "contracts-channels",
      },
      {
        checkName: "checks-fast-contracts-channels-core-a",
        runtime: "node",
        task: "contracts-channels",
      },
      {
        checkName: "checks-fast-contracts-channels-core-b",
        runtime: "node",
        task: "contracts-channels",
      },
      {
        checkName: "checks-fast-contracts-channels-extensions",
        runtime: "node",
        task: "contracts-channels",
      },
    ]);
  });

  it("covers every channel contract test exactly once", () => {
    const actual = createChannelContractTestShards()
      .flatMap((shard) => shard.includePatterns)
      .toSorted((a, b) => a.localeCompare(b));

    expect(actual).toEqual(listContractTests());
    expect(new Set(actual).size).toBe(actual.length);
  });
});
