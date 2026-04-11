import { describe, expect, it } from "vitest";
import { createNodeTestShards } from "../../scripts/lib/ci-node-test-plan.mjs";

describe("scripts/lib/ci-node-test-plan.mjs", () => {
  it("names the node shard checks as stable node lanes", () => {
    const shards = createNodeTestShards();
    const checkNames = shards.map((shard) => shard.checkName);

    expect(shards).not.toHaveLength(0);
    expect(new Set(checkNames).size).toBe(checkNames.length);
    expect(checkNames.every((checkName) => /^checks-node-[a-z0-9-]+$/u.test(checkName))).toBe(
      true,
    );
  });

  it("keeps extension, bundled, contracts, and channels configs out of the core node lane", () => {
    const configs = createNodeTestShards().flatMap((shard) => shard.configs);

    expect(configs).not.toContain("test/vitest/vitest.channels.config.ts");
    expect(configs).not.toContain("test/vitest/vitest.contracts.config.ts");
    expect(configs).not.toContain("test/vitest/vitest.bundled.config.ts");
    expect(configs).not.toContain("test/vitest/vitest.full-extensions.config.ts");
    expect(configs).not.toContain("test/vitest/vitest.extension-telegram.config.ts");
  });
});
