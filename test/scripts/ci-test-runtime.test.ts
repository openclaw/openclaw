import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUN_UI_TEST_ENV,
  ciTestShardRuntimes,
  filterCiTestRuntimeSelections,
  resolveCiTestRuntimeFiles,
  resolveCiTestRuntimeSelections,
} from "../../scripts/lib/ci-test-runtime.mts";

const nodeOnly = "src/cli/cli-process-diagnostics.test.ts";
const bothHosts = "src/infra/sqlite-schema-facts.native.test.ts";
const bunEligible = "src/agents/sandbox/docker.execDockerRaw.enoent.test.ts";
const config = "test/vitest/vitest.unit-fast.config.ts";

describe("CI runtime job inventory", () => {
  it("keeps Node exceptions once and both-host coverage in a mixed bun-all group", () => {
    const group = { configs: [config], includePatterns: [nodeOnly, bothHosts, bunEligible] };
    const original = resolveCiTestRuntimeSelections(group, "bun-all");
    expect(original).toEqual([
      { runtime: "node", vitestArgs: [path.resolve(nodeOnly), path.resolve(bothHosts)] },
      { runtime: "bun", vitestArgs: ["--exclude=" + path.resolve(nodeOnly)] },
    ]);
    expect(ciTestShardRuntimes({ groups: [group] }, "bun-all")).toEqual(["node", "bun"]);
    expect(resolveCiTestRuntimeFiles(group, "bun-all", "node", group.includePatterns)).toEqual(
      [nodeOnly, bothHosts].toSorted(),
    );
    expect(resolveCiTestRuntimeFiles(group, "bun-all", "bun", group.includePatterns)).toEqual(
      [bothHosts, bunEligible].toSorted(),
    );
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
    const original = [{ runtime: "node" }, { runtime: "bun" }] as const;
    const selections = [...original];
    expect(filterCiTestRuntimeSelections(selections, {})).toBe(selections);
    for (const runtime of ["node", "bun"] as const) {
      expect(
        filterCiTestRuntimeSelections(selections, { OPENCLAW_CI_TEST_RUNTIME: runtime }),
      ).toEqual([{ runtime }]);
    }
    expect(() =>
      filterCiTestRuntimeSelections(selections, { OPENCLAW_CI_TEST_RUNTIME: "other" }),
    ).toThrow("expected node or bun");
  });
});
