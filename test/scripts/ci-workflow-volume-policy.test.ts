import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { resolveShardPlans, runShardPlans } from "../../scripts/ci-run-node-test-shard.mts";
import {
  decodeNodeTestGroups,
  encodeNodeTestGroups,
} from "../../scripts/lib/ci-node-test-groups-codec.mts";
import { listNodeTestConfigFiles } from "../../scripts/lib/ci-node-test-inventory.mts";
import { createNodeTestShardBundles } from "../../scripts/lib/ci-node-test-plan.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { runCiManifestFixture as runManifestFixture } from "./ci-workflow-manifest.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
// Reuse content-keyed compiler artifacts; each manifest still gets fresh files and processes.
const compilerTempDir = useAutoCleanupTempDirTracker(afterAll).make(
  "openclaw-ci-manifest-compiler-",
);
const runCiManifestFixture = (options: Parameters<typeof runManifestFixture>[0]) =>
  runManifestFixture(options, compilerTempDir);

const volumeFullPlan = (changedPaths: string[], runnerBackend?: "blacksmith") =>
  createNodeTestShardBundles({
    changedPaths,
    includeReleaseOnlyRuntimeTests: false,
    includePrExemptRuntimeTests: false,
    includeReleaseOnlyPluginShards: false,
    includeReleaseOnlyToolingShards: false,
    includeProofTests: false,
    compactMode: "pull-request",
    runnerBackend,
  });

function readJsonOutput(outputs: Record<string, string>, key: string) {
  return JSON.parse(expectDefined(outputs[key], key));
}

describe("ci workflow guards", () => {
  it.each([
    { policy: "node", fullPlan: true },
    { policy: "dual-all", fullPlan: true },
    { policy: "bun-all", fullPlan: true },
    { policy: "node", fullPlan: false },
  ])(
    "carries direct-target volume without changing $policy execution (full plan=$fullPlan)",
    async ({ policy, fullPlan }) => {
      const byText = (a: unknown, b: unknown) => String(a).localeCompare(String(b));
      const expectUnknown = (rows: { full: unknown; selected: unknown }[]) =>
        expect(rows.every((row) => row.full === null && row.selected === null)).toBe(true);
      const runtimes =
        policy === "dual-all" ? ["node", "bun"] : [policy === "node" ? "node" : "bun"];
      const config = "test/vitest/vitest.utils.config.ts";
      const targets = expectDefined(listNodeTestConfigFiles(config), "config targets").slice(0, 2);
      expect(targets).toHaveLength(2);
      const planner = pathToFileURL(path.resolve("scripts/lib/ci-changed-node-test-plan.mts")).href;
      const normalEnv = {
        CI: "true",
        GITHUB_ACTIONS: "true",
        // This policy matrix owns selection independently of the enclosing runtime job.
        OPENCLAW_CI_TEST_RUNTIME: "",
        OPENCLAW_CI_TEST_RUNTIME_POLICY: policy,
        OPENCLAW_VITEST_INCLUDE_FILE: "",
        OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE: "",
        OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: "[]",
      };
      const manifest = runCiManifestFixture({
        bundledPlanner: true,
        bunTestRuntime: true,
        runtimeJobs: true,
        historicalCompatibility: false,
        eventName: "workflow_dispatch",
        releaseGate: true,
        changedPaths: targets,
        selectedTestTargets: targets,
        scopeEnv: { ...normalEnv, NODE_OPTIONS: "", OPENCLAW_CI_WORKFLOW_REVISION: "a".repeat(40) },
        nodeTestShards: volumeFullPlan(targets, "blacksmith"),
        changedPlannerSource: `
          import { createChangedNodeTestShards as create } from ${JSON.stringify(planner)};
          export { hasQaSmokeAffectingChange, isCiDocumentationPath } from ${JSON.stringify(planner)};
          export function createChangedNodeTestShards(paths, options) {
            const previous = process.cwd();
            try {
              process.chdir(${JSON.stringify(process.cwd())});
              const baseline = create(paths, { ...options, volumeContext: undefined });
              const result = create(paths, { ...options, volumeContext: {
                ...options.volumeContext,
                fullPlan: ${fullPlan ? "options.volumeContext.fullPlan" : "undefined"},
              } });
              const stripped = result.map(({ targetVolumes, ...job }) => ({
                ...job, groups: job.groups?.map(({ volume, ...group }) => group),
              }));
              if (JSON.stringify(stripped) !== JSON.stringify(baseline)) {
                throw new Error("Target volume changed the execution plan");
              }
              return result;
            } finally { process.chdir(previous); }
          }
        `,
      });
      expect(manifest.status, manifest.output).toBe(0);
      // This is the entire manifest output file, including every matrix and pool, in UTF-16
      // characters. Leave half the aggregate 524,288 budget for other preflight producers.
      expect(manifest.outputChars).toBeLessThan(262_144);
      const rows: {
        targets?: string[];
        target_volumes_gzip_base64?: string;
        env?: Record<string, string>;
      }[] = readJsonOutput(manifest.outputs, "checks_node_core_nondist_matrix").include;
      const direct = rows.filter((row) => row.targets?.some((target) => targets.includes(target)));
      expect(direct.flatMap((row) => row.targets).toSorted(byText)).toEqual(
        targets.toSorted(byText),
      );
      const records: {
        runtime: string;
        profile: string;
        full: { id: string } | null;
      }[] = [];
      for (const row of direct) {
        const packed = expectDefined(row.target_volumes_gzip_base64, "packed volume");
        const rowTargets = expectDefined(row.targets, "row targets");
        expect(packed.length).toBeLessThanOrEqual(60_000);
        const env = {
          ...process.env,
          ...normalEnv,
          // Exercise the whole policy, not the runtime split of the enclosing CI job.
          OPENCLAW_CI_TEST_RUNTIME: undefined,
          NODE_OPTIONS: "",
          OPENCLAW_NODE_TEST_ENV_JSON: JSON.stringify(row.env ?? {}),
          OPENCLAW_NODE_TEST_TARGETS_JSON: JSON.stringify(rowTargets),
          OPENCLAW_NODE_TEST_TARGET_VOLUMES_GZIP_BASE64: packed,
        };
        const plans = resolveShardPlans(env);
        expect(plans.map((plan) => plan.kind)).toEqual(rowTargets.map(() => "target"));
        const output: string[] = [];
        const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
          output.push(String(chunk));
          return true;
        });
        try {
          const scratchDir = tempDirs.make("openclaw-direct-volume-");
          const runChild = vi
            .fn<NonNullable<NonNullable<Parameters<typeof runShardPlans>[1]>["runChild"]>>()
            .mockResolvedValue(0);
          const run = async (
            input = plans,
            scenario = false,
            transport: string | null = packed,
          ) => {
            output.length = 0;
            runChild.mockClear();
            expect(
              await runShardPlans(input, {
                concurrency: 1,
                scratchDir,
                env: {
                  ...env,
                  OPENCLAW_NODE_TEST_TARGET_VOLUMES_GZIP_BASE64: transport ?? undefined,
                  ...(scenario ? { OPENCLAW_TEST_VOLUME_SCENARIO: "changed" } : {}),
                },
                runChild,
              }),
            ).toBe(0);
            return output
              .filter((line) => line.startsWith("[shard:volume] "))
              .map((line) => JSON.parse(line.slice("[shard:volume] ".length)));
          };
          const measured = await run();
          expect(measured).toHaveLength(rowTargets.length * runtimes.length);
          expect(measured.every((entry) => entry.config === config)).toBe(true);
          expect(
            measured.every((entry) => (entry.full !== null) === fullPlan),
            JSON.stringify(measured),
          ).toBe(true);
          expect(measured.map((entry) => entry.selected.count)).toEqual(measured.map(() => 1));
          records.push(...measured);
          const calls = [...runChild.mock.calls];
          expect(calls.map(([args]) => args[0]).toSorted(byText)).toEqual(
            rowTargets.flatMap((target) => runtimes.map(() => target)).toSorted(byText),
          );
          const bare = resolveShardPlans({
            OPENCLAW_NODE_TEST_TARGETS_JSON: env.OPENCLAW_NODE_TEST_TARGETS_JSON,
          });
          const unknown = await run(bare, false, null);
          expect(runChild.mock.calls).toEqual(calls);
          expectUnknown(unknown);
          for (const invalid of [
            "not-gzip",
            encodeNodeTestGroups([
              ...decodeNodeTestGroups(packed),
              ...decodeNodeTestGroups(packed),
            ]),
            encodeNodeTestGroups([
              ...decodeNodeTestGroups(packed),
              ...rowTargets.map((target) => ({ target })),
            ]),
            encodeNodeTestGroups(rowTargets.map((target) => ({ target: `unmatched:${target}` }))),
          ]) {
            const ambiguous = await run(
              resolveShardPlans({ ...env, OPENCLAW_NODE_TEST_TARGET_VOLUMES_GZIP_BASE64: invalid }),
              false,
              invalid,
            );
            expect(runChild.mock.calls).toEqual(calls);
            expect(ambiguous).toHaveLength(measured.length);
            expectUnknown(ambiguous);
          }
          if (policy === "node" && fullPlan) {
            for (const [field, value] of [
              ["config", "unmatched.config.ts"],
              ["runtime", "unmatched"],
              ["engine", "unmatched"],
              ["argsDigest", "f".repeat(64)],
              ["environment", "f".repeat(64)],
            ] as const) {
              const mismatched = encodeNodeTestGroups(
                plans.flatMap((plan) =>
                  plan.kind === "target" && plan.volume
                    ? [
                        {
                          target: plan.target,
                          configs: plan.configs,
                          volume: {
                            ...plan.volume,
                            entries: plan.volume.entries.map((entry) => ({
                              ...entry,
                              [field]: value,
                            })),
                          },
                        },
                      ]
                    : [],
                ),
              );
              const rejected = await run(
                resolveShardPlans({
                  ...env,
                  OPENCLAW_NODE_TEST_TARGET_VOLUMES_GZIP_BASE64: mismatched,
                }),
                false,
                mismatched,
              );
              expect(runChild.mock.calls).toEqual(calls);
              expect(rejected).toHaveLength(measured.length);
              expectUnknown(rejected);
            }
          }
          const overridden = await run(plans, true);
          expectUnknown(overridden);
        } finally {
          stdout.mockRestore();
        }
      }
      for (const runtime of runtimes) {
        const matching = records.filter((record) => record.runtime === runtime);
        expect(matching).toHaveLength(targets.length);
        expect(new Set(matching.map((record) => record.full?.id)).size).toBe(1);
        expect(new Set(matching.map((record) => record.profile)).size).toBe(1);
      }
      if (policy === "dual-all") {
        expect(new Set(records.map((record) => record.full?.id)).size).toBe(2);
      }
    },
  );
});
