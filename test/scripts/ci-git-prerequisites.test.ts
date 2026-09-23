import { expect, it } from "vitest";
import prerequisites from "../../.github/actions/git-owner/test-prerequisites.json" with { type: "json" };
import { resolveTestGitCommits } from "../../.github/actions/git-owner/test-prerequisites.mjs";
import { createNodeTestShardBundles } from "../../scripts/lib/ci-node-test-plan.mts";
import { runAuthFixture } from "./ci-checkout-auth.test-support.js";
import { runCiGitStep } from "./ci-git-owner.test-support.js";

const reader = prerequisites.outboundMessageTerminalReader;

it.skipIf(process.platform === "win32").each(["historical", "base"])(
  "reads the %s prerequisite after checkout authentication has ended",
  async (mode) => {
    expect(await runAuthFixture(mode)).toEqual({
      mode,
      preparedObjectsReadable: true,
      credentialPersisted: false,
      postCheckoutRequests: 0,
    });
  },
  50_000,
);

it.each([
  { targets: [reader.file] },
  { configs: reader.configs },
  { groups: [{ configs: reader.configs, includePatterns: ["src/audit/*.test.ts"] }] },
])("selects immutable history for an owning test plan: %j", (plan) => {
  expect(resolveTestGitCommits(plan)).toEqual([reader.commit]);
});

it.each([
  { targets: ["test/scripts/run-opengrep.test.ts"] },
  { configs: ["test/vitest/vitest.agents-core.config.ts"] },
  { groups: [{ configs: reader.configs, includePatterns: ["src/network/*.test.ts"] }] },
  { groups: [] },
])("does not fetch unrelated test history: %j", (plan) => {
  expect(resolveTestGitCommits(plan)).toEqual([]);
});

it.each([false, true])(
  "prepares the reader only in its selected CI shard (compact=%s)",
  (compact) => {
    const shards = createNodeTestShardBundles({ compact });
    expect(shards.filter((shard) => resolveTestGitCommits(shard).length > 0)).toHaveLength(1);
  },
);

it("fetches selected history with the initial checkout before the test worker runs", async () => {
  const report = await runCiGitStep({
    job: "checks-node-core-test-nondist-shard",
    env: { CHECKOUT_GIT_COMMITS_JSON: JSON.stringify([reader.commit]) },
    fetchResults: [0, 0],
  });
  expect(report.code, report.output).toBe(0);
  expect(report.fetches[0]?.args).toContain(reader.commit);
  expect(report.fetches).toHaveLength(2);
});

it.each(["{}", '"main"', '["--upload-pack=bad"]', '["abc"]', "[null]"])(
  "rejects malformed immutable history before checkout mutation: %s",
  async (input) => {
    const report = await runCiGitStep({
      job: "checks-node-core-test-nondist-shard",
      env: { CHECKOUT_GIT_COMMITS_JSON: input },
      fetchResults: [],
    });
    expect(report.code, report.output).toBe(125);
    expect(report.commands).toEqual([]);
    expect(report.output).toContain("Git ownership/setup failed (ValueError)");
  },
);
