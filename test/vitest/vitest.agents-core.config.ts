import { agentsCoreTestPatterns } from "./vitest.agents-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createAgentsCoreVitestConfig(env?: Record<string, string | undefined>) {
  // Cure-(22) drift-rebase absorbed 81 upstream commits + adds ~41K lines + 7 new test files
  // to the agents-core shard. Under FULL-suite-all-shards-parallel load, timing-sensitive
  // tests (QuickJS-WASI sandbox 100ms-timeout in code-mode.test.ts, subagent-announce-delivery
  // long-running tests, etc.) race against system thread-scheduling and produce
  // non-deterministic-per-subtest failures. Per Lane D root-cause investigation (PROOFS corpus
  // c66706221842) + cohort precedent (tasks-shard, cron-shard, telegram-shard, live-shard all
  // use the same isolation pattern for the same failure-class), keep agents-core test-files
  // serialized so the non-isolated runner does not amplify cure-(22)'s test-mass surface-area
  // into ordering-condition failures.
  return createScopedVitestConfig(agentsCoreTestPatterns, {
    dir: "src/agents",
    env,
    fileParallelism: false,
    name: "agents-core",
  });
}

export default createAgentsCoreVitestConfig();
