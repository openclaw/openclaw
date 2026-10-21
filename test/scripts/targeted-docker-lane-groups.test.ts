import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseLaneSelection, resolveDockerE2ePlan } from "../../scripts/lib/docker-e2e-plan.mts";
import {
  UPDATE_FIRST_HOP_MISSING_LOAD_PATH_LANE,
  listRecordedFirstHopSourceVersions,
  updateFirstHopCompatLaneName,
} from "../../scripts/lib/update-first-hop-lanes.mjs";
import { planTargetedDockerLaneGroups } from "../../scripts/plan-targeted-docker-lane-groups.mjs";
import { withTempDir } from "../../src/test-utils/temp-dir.js";

function expandedPlan(
  lanes: string,
  upgradeSurvivorBaselines: string,
  upgradeSurvivorScenarios: string,
  upgradeSurvivorTargetRoot?: string,
) {
  return resolveDockerE2ePlan({
    allowFrozenTargetScenarioOmissions: true,
    includeOpenWebUI: false,
    liveMode: "all",
    orderLanes: (entries) => entries,
    planReleaseAll: false,
    profile: "all",
    releaseChunk: "",
    selectedLaneNames: parseLaneSelection(lanes),
    upgradeSurvivorBaselines,
    upgradeSurvivorScenarios,
    upgradeSurvivorTargetRoot,
  });
}

type Group = ReturnType<typeof planTargetedDockerLaneGroups>[number];
function planGroups(
  lanes: string,
  baselines = "",
  scenarios = "",
  options: NonNullable<Parameters<typeof planTargetedDockerLaneGroups>[0]> = {},
) {
  return planTargetedDockerLaneGroups({
    lanes,
    upgradeSurvivorBaselines: baselines,
    upgradeSurvivorScenarios: scenarios,
    ...options,
  });
}
function groupPlan(group: Group, baselines = "", scenarios = "", targetRoot?: string) {
  return expandedPlan(
    group.docker_lanes,
    group.published_upgrade_survivor_baselines ?? baselines,
    group.published_upgrade_survivor_scenarios ?? scenarios,
    targetRoot,
  );
}

function survivorGroup(version: string, scenario?: string, index = 1): Group {
  return {
    docker_lanes: scenario ? "update-migration" : "published-upgrade-survivor",
    label: scenario
      ? `update-migration-${version}-scenarios-${index}`
      : `published-upgrade-survivor-${version}`,
    published_upgrade_survivor_baselines: `openclaw@${version}`,
    ...(scenario && { published_upgrade_survivor_scenarios: scenario, timeout_minutes: 90 }),
  };
}

function expectExpansion(
  groups: Group[],
  lanes: string,
  baselines: string,
  scenarios: string,
  target?: string,
) {
  const plans = groups.map((group) => groupPlan(group, baselines, scenarios, target));
  const expected = expandedPlan(lanes, baselines, scenarios, target);
  const actual = plans.flatMap((plan) => plan.scheduledLanes);
  const byName = (a: (typeof actual)[number], b: (typeof actual)[number]) =>
    a.name.localeCompare(b.name);
  expect(actual.toSorted(byName)).toEqual(expected.scheduledLanes.toSorted(byName));
  expect(new Set(actual.map((lane) => lane.name)).size).toBe(actual.length);
  expect(plans.flatMap((plan) => plan.omittedUnsupportedLaneNames).toSorted()).toEqual(
    expected.omittedUnsupportedLaneNames.toSorted(),
  );
  return plans;
}

it("retains the reported 9.4 sibling-import cell when current-version baselines are omitted", () => {
  const groups = planGroups(
    "published-upgrade-survivor",
    "2026.9.3",
    "base legacy-operator-state custom-plugin-siblings",
    {
      upgradeSurvivorBaseline: "2026.9.3",
      upgradeSurvivorBaselineScope: "legacy-operator-state",
    },
  );
  expect(
    groups.flatMap((group) => groupPlan(group).scheduledLanes.map((entry) => entry.name)),
  ).toEqual([
    "published-upgrade-survivor-2026.9.3",
    "published-upgrade-survivor-2026.9.3-legacy-operator-state",
    "published-upgrade-survivor-2026.9.4-custom-plugin-siblings",
  ]);
});

it("retains 256 groups and explicitly rejects matrix overflow without dropping coverage", () => {
  const baselines = Array.from({ length: 256 }, (_, index) => `2026.9.${index + 1}`).join(" ");
  expect(planGroups("update-migration", baselines)).toHaveLength(256);
  expect(() => planGroups("update-migration install-smoke", baselines)).toThrow(
    "257 jobs, exceeding the GitHub Actions matrix limit of 256",
  );
  expect(() =>
    planGroups(
      "update-migration",
      baselines,
      "base plugin-deps-cleanup legacy-operator-state bootstrap-persona",
    ),
  ).toThrow("1024 jobs, exceeding the GitHub Actions matrix limit of 256");
});

it("requires an exact predecessor for supported-line pairing", () => {
  expect(() =>
    planGroups("published-upgrade-survivor", "2026.9.2 2026.9.1", "base legacy-operator-state", {
      upgradeSurvivorBaselineScope: "legacy-operator-state",
    }),
  ).toThrow("requires an exact published predecessor");
});

it("runs each recorded first-hop source and the fresh candidate edge as separate jobs", () => {
  const firstHopLanes = listRecordedFirstHopSourceVersions().map(updateFirstHopCompatLaneName);
  const expandedLanes = [...firstHopLanes, UPDATE_FIRST_HOP_MISSING_LOAD_PATH_LANE];
  expect(firstHopLanes.length).toBeGreaterThan(1);
  expect(planGroups("upgrade-survivor update-first-hop-compat")).toEqual([
    { docker_lanes: "upgrade-survivor", label: "upgrade-survivor" },
    ...expandedLanes.map((lane) => ({ docker_lanes: lane, label: lane })),
  ]);
  expect(parseLaneSelection("update-first-hop-compat")).toEqual(expandedLanes);
  // A family token beside one of its members must not schedule that hop twice.
  const mixed = `${UPDATE_FIRST_HOP_MISSING_LOAD_PATH_LANE} update-first-hop-compat`;
  expect(planGroups(mixed).map((group) => group.label)).toEqual([
    UPDATE_FIRST_HOP_MISSING_LOAD_PATH_LANE,
    ...firstHopLanes,
  ]);
  expect(parseLaneSelection(mixed)).toHaveLength(expandedLanes.length);
});

it("shards published upgrade survivor by baseline while preserving surrounding lanes", () => {
  expect(
    planGroups(
      "doctor-switch update-channel-switch published-upgrade-survivor plugins-offline plugin-update",
      "openclaw@2026.6.11-1 openclaw@2026.6.11 openclaw@2026.6.2 openclaw@2026.6.1",
      "",
      { groupSize: 2 },
    ),
  ).toEqual([
    {
      docker_lanes: "doctor-switch update-channel-switch",
      label: "doctor-switch--update-channel-switch",
    },
    ...["2026.6.11-1", "2026.6.11", "2026.6.2", "2026.6.1"].map((version) =>
      survivorGroup(version),
    ),
    { docker_lanes: "plugins-offline plugin-update", label: "plugins-offline--plugin-update" },
  ]);
});

it("rejects pre-June baselines in planner input", () => {
  expect(() => planGroups("update-migration", "2026.6.1 openclaw@2026.5.35")).toThrow(
    "must be 2026.6.1 or newer",
  );
});

it("admits long update jobs before an expanded scenario matrix without changing coverage", () => {
  const lanes =
    "doctor-switch published-upgrade-survivor root-managed-vps-upgrade update-restart-auth plugins-offline plugin-update";
  const baselines = "2026.6.34 2026.8.35 2026.9.7 2026.9.8 2026.9.10";
  const scenarios = "reported-issues";
  const groups = planGroups(lanes, baselines, scenarios);
  expect(groups.length).toBeGreaterThan(32);
  expect(groups[0]?.timeout_minutes).toBe(75);
  expect(groups.slice(0, 3).map((group) => group.docker_lanes)).toEqual([
    "update-restart-auth",
    "plugin-update",
    "root-managed-vps-upgrade",
  ]);
  expect([
    ...new Set(
      groups
        .filter((group) => group.docker_lanes === "published-upgrade-survivor")
        .map((group) => group.published_upgrade_survivor_baselines),
    ),
  ]).toEqual(
    baselines
      .split(" ")
      .toReversed()
      .map((version) => `openclaw@${version}`),
  );
  expectExpansion(groups, lanes, baselines, scenarios);
});

it("isolates the weekly mobile and watch scenarios by baseline", () => {
  const baselines = "2026.7.1 2026.8.1";
  const scenarios = "mobile-pairing-reconnect watchos-direct-node";
  const groups = planGroups("update-migration", baselines, scenarios);
  const plans = groups.map((group) => groupPlan(group, baselines, scenarios));

  expect(groups).toEqual([
    survivorGroup("2026.8.1", "mobile-pairing-reconnect"),
    survivorGroup("2026.8.1", "watchos-direct-node", 2),
    survivorGroup("2026.7.1", "mobile-pairing-reconnect"),
  ]);
  expect(plans.flatMap((plan) => plan.scheduledLanes.map((lane) => lane.name))).toEqual([
    "update-migration-2026.8.1-mobile-pairing-reconnect",
    "update-migration-2026.8.1-watchos-direct-node",
    "update-migration-2026.7.1-mobile-pairing-reconnect",
  ]);
  expect(plans.flatMap((plan) => plan.omittedUnsupportedLaneNames)).toEqual([]);
});

it.each([
  { label: "the default baseline", baselines: "", scenarios: "far-reaching" },
  {
    label: "recovery-only rows",
    baselines: "2026.10.1",
    scenarios:
      "package-publication-recovery package-verification-recovery package-stranded-first-hop",
  },
])("preserves each expanded lane exactly once for $label", ({ baselines, scenarios }) => {
  const lanes = "doctor-switch published-upgrade-survivor update-migration plugin-update";
  const groups = planGroups(lanes, baselines, scenarios, { groupSize: 2 });
  const plans = expectExpansion(groups, lanes, baselines, scenarios);
  expect(new Set(groups.map((group) => group.label)).size).toBe(groups.length);
  for (const [index, group] of groups.entries()) {
    const plan = plans[index]!;
    expect(plan.scheduledLanes.length).toBeGreaterThan(0);
    if (
      group.docker_lanes
        .split(" ")
        .some((lane) => ["published-upgrade-survivor", "update-migration"].includes(lane))
    ) {
      expect(group.published_upgrade_survivor_scenarios).toBeTruthy();
      expect(group.published_upgrade_survivor_scenarios?.split(" ")).toHaveLength(1);
      expect(plan.scheduledLanes).toHaveLength(1);
      expect(group.timeout_minutes).toBe(90);
    }
  }
});

it("preserves frozen-target omissions across scenario shards", async () => {
  await withTempDir("openclaw-survivor-shards-", async (targetRoot) => {
    const harnessDir = join(targetRoot, "scripts/e2e/lib/upgrade-survivor");
    await mkdir(harnessDir, { recursive: true });
    await writeFile(
      join(harnessDir, "assertions.mjs"),
      'console.log(JSON.stringify(["base", "feishu-channel"]));',
    );
    const baselines = "2026.6.1 2026.6.2";
    const scenarios = "reported-issues";
    const lanes = "published-upgrade-survivor";
    const groups = planGroups(lanes, baselines, scenarios);
    const expanded = expectExpansion(groups, lanes, baselines, scenarios, targetRoot);
    for (const plan of expanded) {
      expect(plan.scheduledLanes.length + plan.omittedUnsupportedLaneNames.length).toBeGreaterThan(
        0,
      );
    }
  });
});
