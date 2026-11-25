import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { listNodeTestConfigFiles } from "../../scripts/lib/ci-node-test-inventory.mts";
import {
  ciTestShardRuntimes,
  filterCiTestRuntimeSelections,
  resolveCiTestRuntimeSelections,
  resolveCiTestRuntimeInventory,
} from "../../scripts/lib/ci-test-runtime.mts";
import * as testProjects from "../../scripts/test-projects.test-support.mts";
import { createAgentsSupportVitestConfig } from "../vitest/vitest.agents-support.config.ts";
import { createUnitFastFakeTimersVitestConfig } from "../vitest/vitest.unit-fast-fake-timers.config.ts";
import { listMatchedTestFiles } from "./ci-node-test-plan.test-support.js";

const nodeOnly = "src/cli/cli-process-diagnostics.test.ts";
const gitRelease = "src/infra/git-release.test.ts";
const bothHosts = "src/infra/sqlite-schema-facts.physical-cache.test.ts";
const bunEligible = "src/agents/sandbox/docker.execDockerRaw.enoent.test.ts";
const config = "test/vitest/vitest.unit-fast.config.ts";
const timerConfig = "test/vitest/vitest.unit-fast-fake-timers.config.ts";
const supportConfig = "test/vitest/vitest.agents-support.config.ts";

describe("CI runtime job inventory", () => {
  it.each([timerConfig, supportConfig])(
    "reuses complete %s ownership for accounting without per-exception planning",
    (ownerConfig) => {
      const inventory =
        ownerConfig === timerConfig
          ? listMatchedTestFiles(createUnitFastFakeTimersVitestConfig({}, { argv: [] }))
          : listMatchedTestFiles(createAgentsSupportVitestConfig({}));
      expect(inventory.length).toBeGreaterThan(0);
      const planner = vi.spyOn(testProjects, "buildVitestRunPlans");
      onTestFinished(() => planner.mockRestore());
      const execution = { configs: [ownerConfig] };
      const before = expectDefined(
        resolveCiTestRuntimeInventory(ownerConfig, inventory, {}, "bun-all", execution),
        "whole-config accounting",
      ).map((row) => expectDefined(row, "whole-config runtime row"));
      expect(planner.mock.calls.length).toBeGreaterThan(0);
      planner.mockClear();
      expect(
        resolveCiTestRuntimeInventory(ownerConfig, inventory, {}, "bun-all", execution, inventory),
      ).toEqual(before);

      // Project only the measurement; retain each original runtime, engine and argument envelope.
      const projected = inventory.slice(0, 1);
      expect(
        resolveCiTestRuntimeInventory(ownerConfig, projected, {}, "bun-all", execution, inventory),
      ).toEqual(
        before.map((row) => ({
          ...row,
          files: row.files.filter((file) => projected.includes(file)),
        })),
      );
      const fullNode = { runtime: "node", engine: "vitest", args: [], files: inventory };
      expect(
        resolveCiTestRuntimeInventory(ownerConfig, inventory, {}, "node", execution, inventory),
      ).toEqual([fullNode]);
      expect(
        resolveCiTestRuntimeInventory(ownerConfig, projected, {}, "node", execution, inventory),
      ).toEqual([{ ...fullNode, files: projected }]);
      expect(
        resolveCiTestRuntimeInventory(ownerConfig, inventory, {}, "dual-all", execution, inventory),
      ).toEqual([fullNode, ...before.filter((row) => row.runtime === "bun")]);
      expect(planner).not.toHaveBeenCalled();
    },
  );

  it("retains fallback for an unresolved sibling of a qualified accounting owner", () => {
    const inventory = listMatchedTestFiles(createUnitFastFakeTimersVitestConfig({}, { argv: [] }));
    const execution = { configs: [timerConfig, supportConfig] };
    const planner = vi.spyOn(testProjects, "buildVitestRunPlans");
    onTestFinished(() => planner.mockRestore());
    const before = resolveCiTestRuntimeInventory(timerConfig, inventory, {}, "bun-all", execution);
    expect(planner.mock.calls.length).toBeGreaterThan(0);
    planner.mockClear();
    expect(
      resolveCiTestRuntimeInventory(timerConfig, inventory, {}, "bun-all", execution, inventory),
    ).toEqual(before);
    expect(planner.mock.calls.length).toBeGreaterThan(0);
  });

  it("keeps canonical and explicit membership ahead of accounting hints", () => {
    const planner = vi.spyOn(testProjects, "buildVitestRunPlans");
    onTestFinished(() => planner.mockRestore());
    const canonicalConfig = "test/vitest/vitest.gateway-database-workers.config.ts";
    const canonical = expectDefined(
      listNodeTestConfigFiles(canonicalConfig),
      "canonical inventory",
    );
    expect(canonical.length).toBeGreaterThan(0);
    const cases = [
      { owner: canonicalConfig, files: canonical, execution: { configs: [canonicalConfig] } },
      {
        owner: "unknown.config.ts",
        files: [nodeOnly, bothHosts, bunEligible],
        execution: { configs: ["unknown.config.ts"] },
      },
      {
        owner: timerConfig,
        files: [nodeOnly, bothHosts, bunEligible],
        execution: { configs: [timerConfig], includePatterns: [nodeOnly, bothHosts, bunEligible] },
      },
    ];
    for (const { owner, files, execution } of cases) {
      const before = resolveCiTestRuntimeInventory(owner, files, {}, "bun-all", execution);
      expect(resolveCiTestRuntimeInventory(owner, files, {}, "bun-all", execution, [])).toEqual(
        before,
      );
    }
    expect(planner).not.toHaveBeenCalled();
  });

  it.each([
    { OPENCLAW_VITEST_INCLUDE_FILE: "opaque-includes.json" },
    { OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE: "opaque-post-includes.json" },
    { OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: '["--config","unknown.config.ts"]' },
  ])("keeps opaque accounting unknown despite a complete inventory: %j", (env) => {
    const execution = { configs: [timerConfig] };
    const planner = vi.spyOn(testProjects, "buildVitestRunPlans");
    onTestFinished(() => planner.mockRestore());
    expect(
      resolveCiTestRuntimeInventory(timerConfig, [bunEligible], env, "bun-all", execution),
    ).toBeUndefined();
    expect(
      resolveCiTestRuntimeInventory(timerConfig, [bunEligible], env, "bun-all", execution, [
        bunEligible,
      ]),
    ).toBeUndefined();
    expect(planner).not.toHaveBeenCalled();
  });

  it.each([
    [nodeOnly, bothHosts],
    [nodeOnly, "test/scripts/vitest-pair-benchmark.test.ts"],
    [nodeOnly, "test/scripts/node-cache-disabled-control.test.ts"],
    [nodeOnly, "test/scripts/node-cache-qualification.test.ts"],
    [nodeOnly, "test/vitest-performance-config.test.ts"],
    [gitRelease, bothHosts],
    ["test/scripts/upgrade-survivor-sqlite-observer.test.ts", bothHosts],
    ["test/scripts/upgrade-survivor-bulk-access.test.ts", bothHosts],
    ["test/scripts/upgrade-survivor-migration-chain.test.ts", bothHosts],
  ])(
    "keeps Node-only %s and both-host %s coverage in a mixed bun-all group",
    (nodeContract, bothHost) => {
      const group = { configs: [config], includePatterns: [nodeContract, bothHost, bunEligible] };
      const original = resolveCiTestRuntimeSelections(group, "bun-all");
      expect(original).toEqual([
        { runtime: "node", vitestArgs: [path.resolve(nodeContract), path.resolve(bothHost)] },
        { runtime: "bun", vitestArgs: ["--exclude=" + path.resolve(nodeContract)] },
      ]);
      expect(ciTestShardRuntimes({ groups: [group] }, "bun-all")).toEqual(["node", "bun"]);
      expect(
        ciTestShardRuntimes(
          { groups: [{ configs: [config], includePatterns: [nodeContract] }] },
          "bun-all",
        ),
      ).toEqual(["node"]);
    },
  );

  it.each([
    { configs: ["test/vitest/vitest.infra.config.ts"] },
    { targets: [gitRelease] },
    { configs: ["test/vitest/vitest.infra.config.ts"], includePatterns: [gitRelease] },
  ])("runs Git release contracts on Node under bun-all: %j", (selection) => {
    const selected = resolveCiTestRuntimeSelections(selection, "bun-all");
    if ("includePatterns" in selection || "targets" in selection) {
      expect(selected).toEqual([{ runtime: "node" }]);
    } else {
      expect(selected[0]).toEqual({
        runtime: "node",
        vitestArgs: expect.arrayContaining([path.resolve(gitRelease)]),
      });
      expect(selected[1]).toEqual({
        runtime: "bun",
        vitestArgs: expect.arrayContaining([`--exclude=${path.resolve(gitRelease)}`]),
      });
    }
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
