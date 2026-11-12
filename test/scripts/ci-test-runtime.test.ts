import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUN_UI_TEST_ENV,
  ciTestShardRuntimes,
  filterCiTestRuntimeSelections,
  resolveCiTestRuntimeSelections,
} from "../../scripts/lib/ci-test-runtime.mts";

const nodeOnly = "src/cli/cli-process-diagnostics.test.ts";
const bothHosts = "src/infra/sqlite-schema-facts.native.test.ts";
const bunEligible = "src/agents/sandbox/docker.execDockerRaw.enoent.test.ts";
const config = "test/vitest/vitest.unit-fast.config.ts";

describe("CI runtime job inventory", () => {
  it.each(["node", "bun-all", "dual-all"] as const)(
    "preserves exact-target process envelopes under %s",
    (policy) => {
      const targets = [nodeOnly, bothHosts, bunEligible];
      const original = targets.flatMap((target) =>
        resolveCiTestRuntimeSelections({ targets: [target] }, policy),
      );
      const runtimes = ciTestShardRuntimes({ targets }, policy);
      expect(runtimes).toEqual(policy === "node" ? ["node"] : ["node", "bun"]);
      const split = runtimes.flatMap((runtime) =>
        filterCiTestRuntimeSelections(original, { OPENCLAW_CI_TEST_RUNTIME: runtime }),
      );
      expect(split).toHaveLength(original.length);
      for (const selection of original) {
        expect(split.filter((entry) => entry === selection)).toHaveLength(1);
      }
      const exception = resolveCiTestRuntimeSelections({ targets: [nodeOnly] }, policy);
      expect(exception).toEqual([{ runtime: "node" }]);
      expect(filterCiTestRuntimeSelections(exception, { OPENCLAW_CI_TEST_RUNTIME: "bun" })).toEqual(
        [],
      );
      expect(resolveCiTestRuntimeSelections({ targets: [bothHosts] }, "bun-all")).toEqual([
        { runtime: "node", targets: [bothHosts] },
        { runtime: "bun" },
      ]);
    },
  );

  it("keeps Node exceptions once and both-host coverage in a mixed bun-all group", () => {
    const group = { configs: [config], includePatterns: [nodeOnly, bothHosts, bunEligible] };
    const original = resolveCiTestRuntimeSelections(group, "bun-all");
    expect(original).toEqual([
      { runtime: "node", vitestArgs: [path.resolve(nodeOnly), path.resolve(bothHosts)] },
      { runtime: "bun", vitestArgs: ["--exclude=" + path.resolve(nodeOnly)] },
    ]);
    expect(ciTestShardRuntimes({ groups: [group] }, "bun-all")).toEqual(["node", "bun"]);
    expect(filterCiTestRuntimeSelections(original, { OPENCLAW_CI_TEST_RUNTIME: "node" })).toEqual([
      original[0],
    ]);
    expect(filterCiTestRuntimeSelections(original, { OPENCLAW_CI_TEST_RUNTIME: "bun" })).toEqual([
      original[1],
    ]);
    expect(
      ciTestShardRuntimes(
        { groups: [{ configs: [config], includePatterns: [nodeOnly] }] },
        "bun-all",
      ),
    ).toEqual(["node"]);
  });

  it("retains UI post-shard membership rather than promoting Node-only files to Bun", () => {
    const nodeFile = "ui/src/pages/chat/chat-pane-retention.test.ts";
    const original = resolveCiTestRuntimeSelections(
      {
        configs: ["ui/vitest.config.ts"],
        vitestArgs: ["--maxWorkers=3", "--shard=1/3"],
      },
      "bun-all",
    );
    expect(original).toHaveLength(2);
    const [node, bun] = original;
    if (!node || !bun) {
      throw new Error("UI must retain both runtime selections");
    }
    expect(node).toMatchObject({ runtime: "node", includeAfterShard: true });
    expect(bun).toMatchObject({ runtime: "bun", includeAfterShard: true, env: BUN_UI_TEST_ENV });
    if (node.engine === "bun-test" || bun.engine === "bun-test") {
      throw new Error("UI must preserve Vitest native sharding");
    }
    expect(node.includePatterns).toContain(nodeFile);
    expect(bun.includePatterns).not.toContain(nodeFile);
    expect(
      new Set(node.includePatterns!.filter((file) => bun.includePatterns!.includes(file))).size,
    ).toBe(0);
    expect(filterCiTestRuntimeSelections(original, { OPENCLAW_CI_TEST_RUNTIME: "node" })).toEqual([
      node,
    ]);
    expect(filterCiTestRuntimeSelections(original, { OPENCLAW_CI_TEST_RUNTIME: "bun" })).toEqual([
      bun,
    ]);
  });

  it("includes inherited CLI arguments when selecting grouped runtime jobs", () => {
    const group = { configs: ["test/vitest/vitest.cron.config.ts"] };
    const vitestArgs = ["--shard=1/3"];
    const selected = resolveCiTestRuntimeSelections({ ...group, vitestArgs }, "bun-all");
    expect(selected.map(({ runtime }) => runtime)).toEqual(["node", "bun"]);
    expect(ciTestShardRuntimes({ groups: [group], vitestArgs }, "bun-all")).toEqual([
      "node",
      "bun",
    ]);
  });

  it("leaves unsplit selections unchanged and rejects unknown runtime jobs", () => {
    const original = resolveCiTestRuntimeSelections({ targets: [bunEligible] }, "dual-all");
    expect(filterCiTestRuntimeSelections(original, {})).toBe(original);
    expect(() =>
      filterCiTestRuntimeSelections(original, { OPENCLAW_CI_TEST_RUNTIME: "other" }),
    ).toThrow("expected node or bun");
  });
});
