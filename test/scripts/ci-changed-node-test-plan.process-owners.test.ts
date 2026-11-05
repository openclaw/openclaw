import { expect, it } from "vitest";
import {
  resolveCanonicalNodeTestConfig,
  resolveCompleteCanonicalNodeTestConfig,
} from "../../scripts/lib/ci-node-test-plan.mts";
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

it("resolves exact companion plans through complete canonical shard inventories", () => {
  const target = "src/link-understanding/runner.transport.test.ts";
  const plans = buildVitestRunPlans([target]);
  expect(resolveCompleteCanonicalNodeTestConfig(target, plans)).toBe(
    "test/vitest/vitest.unit-src.config.ts",
  );
  const plan = plans[0]!;
  const config = "test/vitest/vitest.unit-src.config.ts";
  for (const exact of [
    { ...plan, includePatterns: [target], forwardedArgs: [] },
    { ...plan, includePatterns: null, forwardedArgs: [target] },
    { ...plan, includePatterns: [target], forwardedArgs: [target] },
  ]) {
    expect(resolveCompleteCanonicalNodeTestConfig(target, [exact])).toBe(config);
  }
  for (const broad of [
    [],
    [plan, plan],
    [{ ...plan, watchMode: true }],
    [{ ...plan, includePatterns: [], forwardedArgs: [] }],
    [{ ...plan, includePatterns: [target, "src/other.test.ts"] }],
    [{ ...plan, forwardedArgs: [target, "--testNamePattern=partial"] }],
    [{ ...plan, forwardedArgs: ["src/other.test.ts"] }],
  ]) {
    expect(resolveCompleteCanonicalNodeTestConfig(target, broad)).toBeUndefined();
  }
});
