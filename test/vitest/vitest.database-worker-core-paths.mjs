// These consumers need the host-owned SQLite broker, which runs in forked processes.
export const databaseWorkerCoreTestFiles = [
  "src/agents/tools/transcripts-tool-read.test.ts",
  "src/agents/tools/transcripts-tool.account-ownership.test.ts",
  "src/agents/tools/transcripts-tool.auto-start.test.ts",
  "src/agents/tools/transcripts-tool.import.test.ts",
  "src/agents/tools/transcripts-tool.lifecycle.test.ts",
  "src/agents/tools/transcripts-tool.occupancy.test.ts",
  "src/agents/tools/transcripts-tool.selection.test.ts",
  "src/agents/tools/transcripts-tool.session-id.test.ts",
  "src/agents/tools/transcripts-tool.status.test.ts",
  "src/agents/tools/transcripts-tool.test.ts",
  "src/meeting-bot/session-runtime.test.ts",
  "src/meeting-bot/transcripts-bridge.test.ts",
  "src/transcripts/capture-stop.test.ts",
  "src/transcripts/library.async.test.ts",
  "src/transcripts/library.query-budget.test.ts",
  "src/transcripts/library.search.test.ts",
  "src/transcripts/library.test.ts",
  "src/transcripts/status.metadata.test.ts",
  "src/transcripts/status.occupancy.test.ts",
  "src/transcripts/status.producer.test.ts",
  "src/transcripts/status.provider-reload.test.ts",
  "src/transcripts/status.test.ts",
  "src/transcripts/store.test.ts",
  "test/transcripts-tool.discord-lifecycle.integration.test.ts",
  "test/transcripts-tool.discord-provider.integration.test.ts",
  "src/agents/agent-tools.at-prefixed-remote-paths.test.ts",
  "src/agents/agent-tools.create-openclaw-coding-tools.test.ts",
  "src/agents/memory-write-provenance.test.ts",
  "src/commands/doctor-maintenance.worker.test.ts",
  "src/memory/memory-artifact-provenance.test.ts",
  "src/plugin-sdk/memory-host-core.test.ts",
  "src/plugin-sdk/memory-host-events.test.ts",
  "src/plugin-sdk/outbound-media.test.ts",
  "src/plugin-sdk/outbound-media.bulk.test.ts",
  "src/plugin-sdk/outbound-media.retention.test.ts",
  "src/plugin-sdk/provider-auth.test.ts",
  "src/plugin-sdk/provider-auth-copilot-cache.test.ts",
  "src/plugins/doctor-contract-registry.load-paths.test.ts",
  "src/tasks/task-registry.test.ts",
  "test/plugins/beam-http-identity.test.ts",
  "src/plugin-sdk/runtime-doctor-migrations.test.ts",
  "src/plugin-state/plugin-state-store.test.ts",
  "src/plugin-state/plugin-state-store.bulk.test.ts",
  "src/plugin-state/plugin-state-store.errors.test.ts",
  "src/plugin-state/plugin-state-store.expiry.test.ts",
  "src/plugin-state/plugin-state-store.fresh-store.test.ts",
  "src/plugin-state/plugin-state-store.retention.test.ts",
  "src/plugin-state/plugin-state-store.runtime.test.ts",
  "src/plugin-state/plugin-state-store.schema.test.ts",
];

const databaseWorkerCoreTestFileSet = new Set(databaseWorkerCoreTestFiles);

// Preserve watch admission for the two consumers previously inferred into fast lanes.
export const databaseWorkerCoreFormerFastKinds = new Map([
  ["src/plugin-sdk/memory-host-events.test.ts", "unitFastFakeTimers"],
  ["src/plugin-sdk/outbound-media.bulk.test.ts", "unitFast"],
]);

export const DATABASE_WORKER_WATCH_OWNER_ENV_KEY = "OPENCLAW_VITEST_DATABASE_WORKER_WATCH_OWNER";
export const DATABASE_WORKER_WATCH_TESTS_ENV_KEY = "OPENCLAW_VITEST_DATABASE_WORKER_WATCH_TESTS";

export function isDatabaseWorkerCoreTestFile(file) {
  return databaseWorkerCoreTestFileSet.has(file.replaceAll("\\", "/"));
}
