import { expect, it } from "vitest";
import { resolveDockerSeedLanes } from "../../scripts/lib/ci-docker-seed-plan.mts";

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
    "update-channel-switch",
    "fleet-cache",
  ]);
});
