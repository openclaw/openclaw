import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { resolveChangedDockerSeedLanes } from "../../scripts/lib/ci-docker-seed-plan.mts";

const allDockerSeedLanes = ["mcp-channels", "cron-mcp-cleanup", "mcp-code-mode-gateway"];
it.each([
  [["scripts/e2e/mcp-channels-seed.ts"], ["mcp-channels"]],
  [["scripts/e2e/cron-mcp-cleanup-seed.ts"], ["cron-mcp-cleanup"]],
  [["scripts/e2e/mcp-code-mode-gateway-seed.ts"], ["mcp-code-mode-gateway"]],
  [["scripts/e2e/lib/mcp-code-mode-probe-server.ts"], ["mcp-code-mode-gateway"]],
  [["scripts/e2e/lib/mcp-code-mode/scenario.sh"], ["mcp-code-mode-gateway"]],
  [["src/agents/embedded-agent-runner/run/attempt-bundle-tools.ts"], ["mcp-code-mode-gateway"]],
  [["src/agents/runtime-plan/tools.ts"], ["mcp-code-mode-gateway"]],
  [["scripts/e2e/update-channel-switch-docker.sh"], ["update-channel-switch"]],
  [["scripts/e2e/fleet-cache-docker.sh"], ["fleet-cache"]],
  [["scripts/e2e/lib/fleet-cache/assert-cell.mjs"], ["fleet-cache"]],
  [["scripts/e2e/lib/fleet-cache/podman-control.sh"], ["fleet-cache"]],
  [["scripts/e2e/lib/fleet-cache/prepare-podman-storage.mjs"], ["fleet-cache"]],
  [["scripts\\e2e\\lib\\fleet-cache\\probe-podman-cell.mjs"], ["fleet-cache"]],
  [["scripts/e2e/lib/fleet-cache-unrelated/probe.mjs"], []],
  [["scripts/e2e/lib/update-channel-switch/assertions.mjs"], ["update-channel-switch"]],
  [
    [
      "scripts/e2e/update-channel-switch-docker.sh",
      "scripts/e2e/lib/update-channel-switch/assertions.mjs",
      "scripts/e2e/mcp-channels-seed.ts",
    ],
    ["mcp-channels", "update-channel-switch"],
  ],
  [["scripts/e2e/docker-openai-seed.ts"], allDockerSeedLanes],
  [
    [
      "scripts/e2e/mcp-code-mode-gateway-seed.ts",
      "scripts/e2e/mcp-channels-seed.ts",
      "scripts/e2e/lib/mcp-code-mode-probe-server.ts",
      "scripts/e2e/cron-mcp-cleanup-seed.ts",
    ],
    allDockerSeedLanes,
  ],
  [[".github/workflows/ci.yml"], [...allDockerSeedLanes, "published-upgrade-survivor"]],
  [["scripts/lib/ci-changed-node-test-plan.mts"], []],
  ...["scripts/lib/ci-docker-seed-plan.mts", "scripts/lib/changed-path-facts.mjs"].map((owner) => [
    [owner],
    [...allDockerSeedLanes, "published-upgrade-survivor"],
  ]),
  [["scripts\\e2e\\lib\\mcp-code-mode-probe-server.ts"], ["mcp-code-mode-gateway"]],
  [["scripts\\e2e\\lib\\mcp-code-mode\\scenario.sh"], ["mcp-code-mode-gateway"]],
  [["scripts/e2e/install-e2e.ts", "docs/ci.md"], []],
  [["src/commands/doctor-config-preflight.admission.process.test.ts"], []],
  [["src/commands/doctor-config-runtime.test-support.ts"], []],
  [["src\\commands\\doctor-config-runtime.test-support.ts"], []],
  [["src/state/openclaw-state-db-contract.test.ts"], []],
  [["src/state/schema.test-utils.ts"], ["published-upgrade-survivor"]],
  [["src/state/tests/schema.ts"], ["published-upgrade-survivor"]],
  [
    ["src/commands/doctor-config-runtime.test-support.ts", "src/commands/doctor.ts"],
    ["published-upgrade-survivor"],
  ],
  [["src\\state\\openclaw-state-db-contract.ts"], ["published-upgrade-survivor"]],
  [["scripts/e2e/lib/upgrade-survivor/test-support.ts"], ["published-upgrade-survivor"]],
  ...[
    "src/cli/update-cli/run-update.ts",
    "src/infra/update-runner-git.ts",
    "src/infra/package-update-global.ts",
    "src/plugins/update.ts",
    "src/plugins/update-internal.ts",
    "src/commands/doctor.ts",
    "src/commands/doctor-state.ts",
    "src/commands/doctor/migrations/example.ts",
    "src/state/new-state-migration.ts",
    "scripts/e2e/upgrade-survivor-docker.sh",
    "scripts/e2e/lib/upgrade-survivor/assertions.mjs",
    "scripts/lib/docker-e2e-plan.mts",
    "scripts/lib/docker-e2e-scenarios.mts",
    "scripts/resolve-upgrade-survivor-baselines.mts",
    "package.json",
  ].map((owner) => [[owner], ["published-upgrade-survivor"]]),
])("resolves Docker seed lanes for %j", (changedPaths, expected) => {
  expect(resolveChangedDockerSeedLanes(changedPaths)).toEqual(expected);
});

it.each([
  ["src/state/openclaw-state-db-contract.ts", "OPENCLAW_STATE_SCHEMA_VERSION"],
  ["src/state/openclaw-agent-db-contract.ts", "OPENCLAW_AGENT_SCHEMA_VERSION"],
])("always gates schema-version changes in %s with a published upgrade", (owner, constant) => {
  // A moved constant must update this independent owner guarantee, not silently lose the gate.
  expect(readFileSync(owner, "utf8")).toMatch(new RegExp(`export const ${constant} = \\d+;`));
  expect(resolveChangedDockerSeedLanes([owner])).toEqual(["published-upgrade-survivor"]);
});
