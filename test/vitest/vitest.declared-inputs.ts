import path from "node:path";
import type { Plugin } from "vitest/config";

// The v24 agent input combines the v21 trigger definitions with the v26 layout.
const agentV24Tests = [
  "src/commands/doctor-agent-deletion-journal-restore.test.ts",
  "src/commands/doctor-historical-imports.process.test.ts",
  "src/commands/doctor-migration-preservation.test.ts",
  "src/commands/doctor-schema-migrations.test.ts",
  "src/commands/doctor-systemd-activation.test.ts",
  "src/commands/doctor-update-schema-guard.test.ts",
  "src/flows/doctor-health.update-schema.test.ts",
  "src/infra/database-engine/port-command.test.ts",
  "src/infra/state-migrations.media-persistence.historical.test.ts",
  "src/state/openclaw-agent-canonical-validation-schema.test.ts",
  "src/state/openclaw-agent-json-predicate-schema.test.ts",
  "src/state/openclaw-agent-session-snapshots-migration.test.ts",
];

const stateCorpusTests = ["test/state-upgrade.e2e.test.ts"];

const historicalFixtureInputs = [
  [
    "test/fixtures/sqlite/openclaw-agent-schema-v21.sql",
    [
      ...agentV24Tests,
      "src/commands/doctor-config-preflight.container-upgrade.test.ts",
      "src/flows/doctor-health.dangling-workshop-index.test.ts",
      "src/state/openclaw-agent-db.storage-migration.test.ts",
      "src/state/openclaw-agent-participants-migration.test.ts",
    ],
  ],
  [
    "test/fixtures/sqlite/openclaw-agent-schema-v26.sql",
    [
      ...agentV24Tests,
      "src/cli/gateway-cli/run.option-collisions.test.ts",
      "src/commands/doctor-session-sqlite.targets.test.ts",
      "src/infra/database-engine/agent-port-descriptor.test.ts",
      "src/infra/database-engine/memory-path-migration.conformance.test.ts",
      "src/infra/state-migrations.cold-navigation.test.ts",
      "src/infra/state-migrations.media-persistence.bounded.test.ts",
      "src/infra/update-candidate-rehearsal.resources.test.ts",
      "src/snapshot/local-repository.test.ts",
      "src/state/openclaw-agent-active-event-facts-migration.test.ts",
      "src/state/openclaw-agent-cold-archive-chunks-migration.test.ts",
      "src/state/openclaw-agent-cold-navigation-migration.test.ts",
      "src/state/openclaw-agent-creation-operations-migration.test.ts",
      "src/state/openclaw-agent-index-retirement-migration.test.ts",
      "src/state/openclaw-agent-member-access-migration.test.ts",
      "src/state/openclaw-agent-memory-revision-migration.test.ts",
      "src/state/openclaw-agent-tool-usage-migration.test.ts",
      "src/state/openclaw-agent-trajectory-storage-migration.test.ts",
      "src/state/openclaw-agent-vector-decoder-migration.test.ts",
      "src/state/openclaw-agent-write-layout-migration.test.ts",
      "test/doctor-guest-session-upgrade.e2e.test.ts",
      "test/scripts/upgrade-survivor-migration-chain.test.ts",
    ],
  ],
  [
    "test/fixtures/sqlite/openclaw-state-schema-v35.sql",
    [
      "src/commands/doctor-historical-imports.process.test.ts",
      "src/commands/startup-client-credentials.test.ts",
      "src/state/openclaw-state-db-head-layout-migration.test.ts",
      "src/state/openclaw-state-db-historical-imports.test.ts",
      "src/state/openclaw-state-db-image-snapshot-migration.test.ts",
      "src/state/openclaw-state-db-write-index-migration.test.ts",
    ],
  ],
  ["test/fixtures/state-corpus-populated/2026.7.1/manifest.json", stateCorpusTests],
  ["test/fixtures/state-corpus-populated/2026.8.35/manifest.json", stateCorpusTests],
  ["test/fixtures/state-corpus-populated/2026.9.37/manifest.json", stateCorpusTests],
  ["test/fixtures/state-corpus-populated/2026.10.10/manifest.json", stateCorpusTests],
] as const;

/** Shared by CI routing and native Vitest dependency recording. */
export const vitestDeclaredInputs = [
  ["src/hooks/install.test.ts", "test/fixtures/hooks-install/tar-evil-id.tar"],
  ["src/config/defaults.ollama-output-cap.test.ts", "extensions/ollama/openclaw.plugin.json"],
  ...historicalFixtureInputs.flatMap(([input, tests]) =>
    tests.map((test) => [test, input] as const),
  ),
] as const;

/** File reads that cannot be expressed as module imports belong to their test. */
export function createVitestDeclaredInputsPlugin(root: string): Plugin {
  const inputs = new Map<string, string[]>();
  for (const [test, input] of vitestDeclaredInputs) {
    const file = path.resolve(root, test);
    const paths = inputs.get(file) ?? [];
    paths.push(path.resolve(root, input));
    inputs.set(file, paths);
  }
  return {
    name: "openclaw:declared-test-inputs",
    enforce: "pre",
    transform(_source, id) {
      for (const input of inputs.get(path.resolve(id.split("?")[0]!)) ?? []) {
        this.addWatchFile(input);
      }
      return null;
    },
  };
}
