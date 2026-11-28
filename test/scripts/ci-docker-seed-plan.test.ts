import { expect, it } from "vitest";
import {
  resolveChangedDockerSeedLanes,
  resolveDockerSeedLanes,
} from "../../scripts/lib/ci-docker-seed-plan.mts";

it("keeps the published-driver update tripwire in the main tier", () => {
  expect(resolveDockerSeedLanes({ includeReleaseOnly: false })).toEqual([
    "published-upgrade-survivor",
  ]);
});

it("keeps the manual seed profile within its existing budget", () => {
  expect(resolveDockerSeedLanes({ includeReleaseOnly: true })).toEqual([
    "published-upgrade-survivor",
    "mcp-channels",
    "cron-mcp-cleanup",
    "mcp-code-mode-gateway",
    "mcp-docker-custody",
    "update-channel-switch",
  ]);
});

it.each([
  ["scripts/e2e/mcp-channels-seed.ts", ["mcp-channels"]],
  ["scripts/e2e/lib/update-channel-switch/assertions.mjs", ["update-channel-switch"]],
  ["src/agents/mcp-docker-custody.ts", ["mcp-docker-custody"]],
  ["src/gateway/server-startup-bootstrap.ts", ["mcp-docker-custody"]],
  ["src/cli/mcp-cli-state-owner.ts", ["mcp-docker-custody"]],
  ["src/cli/mcp-cli.ts", ["mcp-docker-custody"]],
  ["src/cli/mcp-cli-probe.ts", ["mcp-docker-custody"]],
  ["scripts/e2e/lib/mcp-docker-custody/scenario.mjs", ["mcp-docker-custody"]],
  ["src/update/run.ts", ["release-update-survivor"]],
  ["src/update/prepare.test.ts", []],
  ["src/update/prepare-iroh.test-support.ts", []],
  ["src\\update\\prepare-iroh.test-support.ts", []],
  ["src/update/new-owner.json", ["release-update-survivor"]],
  ["src/state/schema-migration.test-support.ts", ["release-update-survivor"]],
  ["src/state/openclaw-state-schema.ts", ["release-update-survivor"]],
  ["src/cli/update-cli/update-command.ts", ["release-update-survivor"]],
  ["src/daemon/service.ts", ["release-update-survivor"]],
  ["openclaw.mjs", ["release-update-survivor"]],
  ["release-launcher-forward.mjs", ["release-update-survivor"]],
  ["src\\update\\launcher.ts", ["release-update-survivor"]],
  ["scripts/e2e/lib/upgrade-survivor/release-fixture.mjs", ["release-update-survivor"]],
  ["scripts/e2e/upgrade-survivor-docker.sh", ["release-update-survivor"]],
  ["src/updates/unrelated.ts", []],
] as const)("selects only Docker owner lanes for %s", (file, expected) => {
  expect(resolveChangedDockerSeedLanes([file])).toEqual(expected);
});

it("deduplicates owner lanes in the canonical execution order", () => {
  expect(
    resolveChangedDockerSeedLanes(["scripts/e2e/mcp-channels-seed.ts", ".github/workflows/ci.yml"]),
  ).toEqual(["mcp-channels", "cron-mcp-cleanup", "mcp-code-mode-gateway"]);
});

it("retains production update and explicit Docker owners alongside test helpers", () => {
  expect(
    resolveChangedDockerSeedLanes([
      "src/update/prepare-iroh.test-support.ts",
      "src/update/prepare-git.ts",
      "scripts/e2e/mcp-channels-seed.ts",
    ]),
  ).toEqual(["mcp-channels", "release-update-survivor"]);
});
