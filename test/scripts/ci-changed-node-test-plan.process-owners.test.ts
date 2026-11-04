import { expect, it } from "vitest";
import { resolveCanonicalNodeTestConfig } from "../../scripts/lib/ci-node-test-plan.mts";
import { buildVitestRunPlans } from "../../scripts/test-projects.test-support.mts";
import {
  createChangedNodeTestShards,
  selectedFiles,
} from "./ci-changed-node-test-plan.test-support.js";

it("keeps the TUI support unit owner without a fallback", () => {
  const target = "src/tui/tui-pty-local-test-support.test.ts";
  const reasons: string[] = [];
  const shards = createChangedNodeTestShards([target], {
    dedicatedBuildArtifacts: false,
    onFallback: (reason) => reasons.push(reason),
  });
  expect(reasons).toEqual([]);
  expect(shards).not.toBeNull();
  expect(selectedFiles(shards).filter((file) => file === target)).toEqual([target]);
  const config = "test/vitest/vitest.tui.config.ts";
  expect(buildVitestRunPlans([target])[0]?.config).toBe(config);
  expect(resolveCanonicalNodeTestConfig(target, config)).toBe(config);
  expect(shards?.some((shard) => shard.requiresDist)).toBe(false);
});
