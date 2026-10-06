import { expect, it } from "vitest";
import { createSelectedNodeTestShardBundles } from "../../scripts/lib/ci-node-test-plan.mts";

it("admits the incoming-call MJS suites into a bounded canonical CI plan", () => {
  const targets = [
    "test/scripts/incoming-calls-incoming-call.test.mjs",
    "test/scripts/incoming-calls-sdk-transport.test.mjs",
  ];
  const reasons: string[] = [];
  const plan = createSelectedNodeTestShardBundles(targets, {
    runnerBackend: "github",
    onFallback: (reason) => reasons.push(reason),
  });
  expect(plan, reasons.join("\n")).not.toBeNull();
  const groups = plan!.flatMap((job) => job.groups);
  expect(groups.flatMap((group) => group.includePatterns ?? []).toSorted()).toEqual(
    targets.toSorted(),
  );
  expect(
    groups.every(
      (group) =>
        group.configs.length === 1 && group.configs[0] === "test/vitest/vitest.tooling.config.ts",
    ),
  ).toBe(true);
});
