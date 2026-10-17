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

it("retains every Docker seed owner in full release validation", () => {
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
  ["scripts/e2e/lib/mcp-docker-custody/scenario.mjs", ["mcp-docker-custody"]],
  ["src/state/openclaw-state-schema.ts", []],
] as const)("selects only Docker owner lanes for %s", (file, expected) => {
  expect(resolveChangedDockerSeedLanes([file])).toEqual(expected);
});

it("deduplicates owner lanes in the canonical execution order", () => {
  expect(
    resolveChangedDockerSeedLanes(["scripts/e2e/mcp-channels-seed.ts", ".github/workflows/ci.yml"]),
  ).toEqual(["mcp-channels", "cron-mcp-cleanup", "mcp-code-mode-gateway"]);
});
