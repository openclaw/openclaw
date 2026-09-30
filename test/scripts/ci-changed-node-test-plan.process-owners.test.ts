import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { resolveTestGitCommits } from "../../.github/actions/git-owner/test-prerequisites.mjs";
import { resolveShardPlans } from "../../scripts/ci-run-node-test-shard.mts";
import {
  createChangedNodeTestShards as createChangedNodeTestShardsWithSmoke,
  resolveChangedNodeTestTargets,
} from "../../scripts/lib/ci-changed-node-test-plan.mts";
import { encodeNodeTestGroups } from "../../scripts/lib/ci-node-test-groups-codec.mts";
import {
  createNodeTestShardBundles,
  createSelectedNodeTestShardBundles,
} from "../../scripts/lib/ci-node-test-plan.mts";
import { buildVitestRunPlans } from "../../scripts/test-projects.test-support.mts";
import {
  createChangedNodeTestShards,
  fallbackGroups,
  selectedFiles,
} from "./ci-changed-node-test-plan.test-support.js";

describe("CI changed Node test plan", () => {
  it("keeps system-runtime process proofs serial beside SQLite worker coverage", () => {
    const changedPaths = [
      "src/infra/sqlite-worker-store.ts",
      "src/state/openclaw-agent-execution.ts",
    ];
    const selectedTestTargets = resolveChangedNodeTestTargets(changedPaths, {
      includePrExemptRuntimeTests: false,
      includeReleaseOnlyRuntimeTests: false,
    });
    const shards = expectDefined(
      createChangedNodeTestShardsWithSmoke(changedPaths, {
        compactNodeJobCap: 130,
        dedicatedBuildArtifacts: false,
        dedicatedMaxLinesRatchet: true,
        dedicatedNativeChecks: { android: false, ios: false, macos: false },
        dedicatedUiE2e: true,
        dedicatedUiTests: true,
        includePrExemptRuntimeTests: false,
        includeReleaseOnlyRuntimeTests: false,
        runnerBackend: "hybrid",
        selectedTestTargets,
      }),
      "changed process and storage plan",
    );
    const systemRuntime = expectDefined(
      shards
        .flatMap((job) => job.groups ?? [])
        .find((group) => group.shard_name.startsWith("core-runtime-infra-system-runtime-hosted-")),
      "system-runtime process owner",
    );
    const job = expectDefined(
      shards.find((candidate) => candidate.groups?.includes(systemRuntime)),
      "system-runtime process job",
    );

    expect(systemRuntime.env?.OPENCLAW_VITEST_MAX_WORKERS).toBe("2");
    expect(job.planConcurrency).toBe(1);
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
      const ownerJob = expectDefined(
        full.find((job) =>
          job.groups.some((group) => group.shard_name === "core-tooling-isolated"),
        ),
        "canonical paired tooling job",
      );
      const owner = expectDefined(
        ownerJob.groups.find((group) => group.shard_name === "core-tooling-isolated"),
        "canonical paired tooling group",
      );
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
        const selected = expectDefined(
          createSelectedNodeTestShardBundles(targets, { runnerBackend }),
          "selected paired tooling plan",
        );
        const pairs = selected.flatMap((job) =>
          job.groups.filter((group) => group.shard_name === "core-tooling-isolated"),
        );
        expect(pairs).toEqual([owner]);
        const changed = expectDefined(
          createChangedNodeTestShards(targets, { runnerBackend }),
          "changed paired tooling plan",
        );
        const changedPairs = changed.flatMap((job) =>
          (job.groups ?? []).filter((group) => group.shard_name === "core-tooling-isolated"),
        );
        expect(changedPairs).toEqual([owner]);
        const changedJob = expectDefined(
          changed.find((job) => job.groups?.includes(changedPairs[0]!)),
          "changed paired tooling job",
        );
        expect(changedJob.env).toEqual(ownerJob.env);
        expect(changedJob.runner).toBe(ownerJob.runner);
        expect(changedJob.planConcurrency).toBe(ownerJob.planConcurrency);
        expect(changedJob.pretestBuildMode).toBe(ownerJob.pretestBuildMode);
        expect(changedJob.timeoutMinutes).toBe(ownerJob.timeoutMinutes);
        const selectedJob = expectDefined(
          selected.find((job) => job.groups.includes(pairs[0]!)),
          "selected paired tooling job",
        );
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
        const encodedGroups = selectedJob.groups.map(
          ({ configs, env, includePatterns, shard_name, timing_key }) => ({
            configs,
            env,
            includePatterns,
            shard_name,
            timing_key,
          }),
        );
        expect(
          resolveShardPlans({
            OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: encodeNodeTestGroups(encodedGroups),
          }),
        ).toEqual(
          encodedGroups.map((plan) => ({
            kind: "group",
            name: plan.shard_name,
            timingKey: plan.timing_key ?? plan.shard_name,
            plan,
          })),
        );
        expect(resolveTestGitCommits(selectedJob)).toEqual(
          resolveTestGitCommits({ groups: [owner] }),
        );
        for (const target of targets.filter((file) => file !== docker && file !== isolated)) {
          expect(
            selected.some((job) =>
              job.groups.some(
                (group) =>
                  group.includePatterns?.includes(target) ||
                  (!group.includePatterns &&
                    group.configs.includes(buildVitestRunPlans([target])[0]!.config)),
              ),
            ),
          ).toBe(true);
        }
      }
    },
  );

  it("retains leaf-config owners and their execution metadata", () => {
    const config = "test/vitest/vitest.commands.config.ts";
    const full = createNodeTestShardBundles({
      compactMode: "pull-request",
      includeReleaseOnlyPluginShards: false,
      includeReleaseOnlyToolingShards: true,
    });
    const owners = full.flatMap((job) =>
      job.groups.filter((group) => group.configs.includes(config)),
    );
    expect(owners.length).toBeGreaterThan(1);
    const expectCanonicalCommands = (shards: ReturnType<typeof createChangedNodeTestShards>) => {
      expect(shards).not.toBeNull();
      const groups = fallbackGroups(shards ?? []);
      const selectedOwners = groups.filter((group) => group.configs.includes(config));
      expect(selectedOwners.flatMap((group) => group.includePatterns ?? []).toSorted()).toEqual(
        owners.flatMap((group) => group.includePatterns ?? []).toSorted(),
      );
      expect(selectedOwners.every((group) => (group.includePatterns?.length ?? 0) > 0)).toBe(true);
      for (const owner of owners) {
        const fullJob = expectDefined(
          full.find((job) => job.groups.includes(owner)),
          "canonical commands job",
        );
        const selectedJob = expectDefined(
          shards?.find((job) => job.groups?.some((group) => group.shard_name === owner.shard_name)),
          "selected commands job",
        );
        expect(selectedJob.runner).toBe(fullJob.runner);
        expect(selectedJob.env).toEqual(fullJob.env);
        expect(selectedJob.planConcurrency).toBe(fullJob.planConcurrency);
        expect(selectedJob.pretestBuildMode).toBe(fullJob.pretestBuildMode);
        expect(selectedJob.timeoutMinutes).toBe(fullJob.timeoutMinutes);
      }
      const configs = groups.flatMap((group) => group.configs);
      expect(configs).not.toContain("test/vitest/vitest.cron.config.ts");
      expect(configs).not.toContain("test/vitest/vitest.ui.config.ts");
    };
    const shards = createChangedNodeTestShards([config]);
    expectCanonicalCommands(shards);
    expect(
      createChangedNodeTestShards([config], {
        includePrExemptRuntimeTests: false,
        includeReleaseOnlyRuntimeTests: false,
      }),
    ).toEqual(shards);
    expect(selectedFiles(shards)).toEqual(
      expect.arrayContaining([
        "test/vitest-projects-config.test.ts",
        "test/vitest-scoped-config.test.ts",
        "test/scripts/ci-node-test-plan.commands.test.ts",
      ]),
    );
  });
});
