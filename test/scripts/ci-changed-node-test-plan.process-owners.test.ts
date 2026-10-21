import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { resolveTestGitCommits } from "../../.github/actions/git-owner/test-prerequisites.mjs";
import { resolveShardPlans } from "../../scripts/ci-run-node-test-shard.mts";
import { encodeNodeTestGroups } from "../../scripts/lib/ci-node-test-groups-codec.mts";
import {
  createNodeTestShardBundles,
  createSelectedNodeTestShardBundles,
  resolveCanonicalNodeTestConfig,
  type NodeTestShardGroup,
} from "../../scripts/lib/ci-node-test-plan.mts";
import { buildVitestRunPlans } from "../../scripts/test-projects.test-support.mts";
import {
  createChangedNodeTestShards,
  selectedFiles,
} from "./ci-changed-node-test-plan.test-support.js";

function pairedPlan<T extends { groups?: NodeTestShardGroup[] }>(input: T[] | null) {
  const jobs = expectDefined(input, "paired tooling plan");
  const pairs = jobs.flatMap((job) =>
    (job.groups ?? []).filter((group) => group.shard_name === "core-tooling-isolated"),
  );
  const job = expectDefined(
    jobs.find((candidate) => candidate.groups?.includes(pairs[0]!)),
    "paired tooling job",
  );
  return { jobs, job, pairs, owner: expectDefined(pairs[0], "paired tooling group") };
}

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

it.each(["blacksmith", "github", "hybrid"])(
  "retains the complete paired tooling descriptor and job metadata (%s)",
  (runnerBackend) => {
    const docker = "test/scripts/docker-build-helper.test.ts";
    const isolated = "test/plugins/bundled-provider-auth-literal-parity.test.ts";
    const full = createNodeTestShardBundles({
      compactMode: "pull-request",
      runnerBackend,
      includeReleaseOnlyPluginShards: false,
    });
    const { job: ownerJob, owner } = pairedPlan(full);
    expect(owner.configs).toEqual([
      "test/vitest/vitest.tooling-docker.config.ts",
      "test/vitest/vitest.tooling-isolated.config.ts",
    ]);
    expect(owner.includePatterns).toBeUndefined();
    expect(owner.env?.OPENCLAW_VITEST_MAX_WORKERS).toBe("2");
    expect(ownerJob.planConcurrency).toBe(1);

    for (const targets of [
      [docker],
      [isolated],
      [docker, isolated, "test/scripts/docker-e2e-update-suppression.test.ts", docker, isolated],
      [isolated, "test/scripts/ci-linux-git.test.ts"],
      [docker, "src/agents/embedded-agent-runner/run/attempt-yield-handoff.test.ts"],
      [docker, "src/tui/tui-pty-local.e2e.test.ts"],
    ]) {
      const {
        jobs: selected,
        job: selectedJob,
        pairs,
      } = pairedPlan(createSelectedNodeTestShardBundles(targets, { runnerBackend }));
      expect(pairs).toEqual([owner]);
      const { job: changedJob, pairs: changedPairs } = pairedPlan(
        createChangedNodeTestShards(targets, { runnerBackend }),
      );
      expect(changedPairs).toEqual([owner]);
      const metadata = (job: typeof ownerJob | typeof changedJob) => [
        job.env,
        job.runner,
        job.planConcurrency,
        job.pretestBuildMode,
        job.timeoutMinutes,
      ];
      expect(metadata(changedJob)).toEqual(metadata(ownerJob));
      expect(selectedJob).toEqual({
        ...ownerJob,
        checkName: `checks-node-changed-${ownerJob.shardName}`,
        shardName: `changed-${ownerJob.shardName}`,
        groups: [owner],
        predictedSeconds: expect.any(Number),
        predictedTestSeconds: selectedJob.predictedSeconds,
      });
      expect(selectedJob.predictedSeconds).toBeGreaterThan(0);
      expect(selectedJob.predictedSeconds).toBeLessThanOrEqual(ownerJob.predictedSeconds!);
      const { configs, env, includePatterns, shard_name, timing_key } = owner;
      const plan = { configs, env, includePatterns, shard_name, timing_key };
      expect(
        resolveShardPlans({
          OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: encodeNodeTestGroups([plan]),
        }),
      ).toEqual([{ kind: "group", name: shard_name, timingKey: timing_key ?? shard_name, plan }]);
      expect(resolveTestGitCommits(selectedJob)).toEqual(
        resolveTestGitCommits({ groups: [owner] }),
      );
      for (const target of targets.filter((file) => file !== docker && file !== isolated)) {
        const config = buildVitestRunPlans([target])[0]!.config;
        expect(
          selected
            .flatMap((job) => job.groups)
            .some(
              (group) =>
                group.includePatterns?.includes(target) ||
                (!group.includePatterns && group.configs.includes(config)),
            ),
        ).toBe(true);
      }
    }
  },
);
