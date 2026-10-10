// Targeted Docker Lane Groups tests cover targeted docker lane groups script behavior.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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

describe("scripts/plan-targeted-docker-lane-groups", () => {
  it("retains the reported 9.4 sibling-import cell when current-version baselines are omitted", () => {
    const groups = planTargetedDockerLaneGroups({
      lanes: "published-upgrade-survivor",
      upgradeSurvivorBaseline: "2026.9.3",
      upgradeSurvivorBaselines: "2026.9.3",
      upgradeSurvivorScenarios: "base legacy-operator-state custom-plugin-siblings",
      upgradeSurvivorBaselineScope: "legacy-operator-state",
    });
    expect(
      groups.flatMap((group) =>
        expandedPlan(
          group.docker_lanes,
          group.published_upgrade_survivor_baselines ?? "",
          group.published_upgrade_survivor_scenarios ?? "",
        ).scheduledLanes.map((entry) => entry.name),
      ),
    ).toEqual([
      "published-upgrade-survivor-2026.9.3",
      "published-upgrade-survivor-2026.9.3-legacy-operator-state",
      "published-upgrade-survivor-2026.9.4-custom-plugin-siblings",
    ]);
  });

  it("retains 256 groups and explicitly rejects matrix overflow without dropping coverage", () => {
    const baselines = Array.from({ length: 256 }, (_, index) => `2026.9.${index + 1}`).join(" ");
    expect(
      planTargetedDockerLaneGroups({
        lanes: "update-migration",
        upgradeSurvivorBaselines: baselines,
      }),
    ).toHaveLength(256);
    expect(() =>
      planTargetedDockerLaneGroups({
        lanes: "update-migration install-smoke",
        upgradeSurvivorBaselines: baselines,
      }),
    ).toThrow("257 jobs, exceeding the GitHub Actions matrix limit of 256");
    expect(() =>
      planTargetedDockerLaneGroups({
        lanes: "update-migration",
        upgradeSurvivorBaselines: baselines,
        upgradeSurvivorScenarios:
          "base plugin-deps-cleanup legacy-operator-state bootstrap-persona",
      }),
    ).toThrow("1024 jobs, exceeding the GitHub Actions matrix limit of 256");
  });

  it("requires an exact predecessor for supported-line pairing", () => {
    expect(() =>
      planTargetedDockerLaneGroups({
        lanes: "published-upgrade-survivor",
        upgradeSurvivorBaselines: "2026.9.2 2026.9.1",
        upgradeSurvivorScenarios: "base legacy-operator-state",
        upgradeSurvivorBaselineScope: "legacy-operator-state",
      }),
    ).toThrow("requires an exact published predecessor");
  });

  it("runs each recorded first-hop source and the fresh candidate edge as separate jobs", () => {
    const firstHopLanes = listRecordedFirstHopSourceVersions().map(updateFirstHopCompatLaneName);
    const expandedLanes = [...firstHopLanes, UPDATE_FIRST_HOP_MISSING_LOAD_PATH_LANE];
    expect(firstHopLanes.length).toBeGreaterThan(1);
    expect(
      planTargetedDockerLaneGroups({ lanes: "upgrade-survivor update-first-hop-compat" }),
    ).toEqual([
      { docker_lanes: "upgrade-survivor", label: "upgrade-survivor" },
      ...expandedLanes.map((lane) => ({ docker_lanes: lane, label: lane })),
    ]);
    expect(parseLaneSelection("update-first-hop-compat")).toEqual(expandedLanes);
    // A family token beside one of its members must not schedule that hop twice.
    const mixed = `${UPDATE_FIRST_HOP_MISSING_LOAD_PATH_LANE} update-first-hop-compat`;
    expect(planTargetedDockerLaneGroups({ lanes: mixed }).map((group) => group.label)).toEqual([
      UPDATE_FIRST_HOP_MISSING_LOAD_PATH_LANE,
      ...firstHopLanes,
    ]);
    expect(parseLaneSelection(mixed)).toHaveLength(expandedLanes.length);
  });

  it("shards published upgrade survivor by baseline while preserving surrounding lanes", () => {
    expect(
      planTargetedDockerLaneGroups({
        groupSize: 2,
        lanes:
          "doctor-switch update-channel-switch published-upgrade-survivor plugins-offline plugin-update",
        upgradeSurvivorBaselines:
          "openclaw@2026.6.11-1 openclaw@2026.6.11 openclaw@2026.6.2 openclaw@2026.6.1",
      }),
    ).toEqual([
      {
        docker_lanes: "doctor-switch update-channel-switch",
        label: "doctor-switch--update-channel-switch",
      },
      {
        docker_lanes: "published-upgrade-survivor",
        label: "published-upgrade-survivor-2026.6.11-1",
        published_upgrade_survivor_baselines: "openclaw@2026.6.11-1",
      },
      {
        docker_lanes: "published-upgrade-survivor",
        label: "published-upgrade-survivor-2026.6.11",
        published_upgrade_survivor_baselines: "openclaw@2026.6.11",
      },
      {
        docker_lanes: "published-upgrade-survivor",
        label: "published-upgrade-survivor-2026.6.2",
        published_upgrade_survivor_baselines: "openclaw@2026.6.2",
      },
      {
        docker_lanes: "published-upgrade-survivor",
        label: "published-upgrade-survivor-2026.6.1",
        published_upgrade_survivor_baselines: "openclaw@2026.6.1",
      },
      { docker_lanes: "plugins-offline plugin-update", label: "plugins-offline--plugin-update" },
    ]);
  });

  it("rejects pre-June baselines in planner input", () => {
    expect(() =>
      planTargetedDockerLaneGroups({
        lanes: "update-migration",
        upgradeSurvivorBaselines: "2026.6.1 openclaw@2026.5.35",
      }),
    ).toThrow("must be 2026.6.1 or newer");
  });

  it("admits long update jobs before an expanded scenario matrix without changing coverage", () => {
    const lanes =
      "doctor-switch published-upgrade-survivor root-managed-vps-upgrade update-restart-auth plugins-offline plugin-update";
    const baselines = "2026.6.34 2026.8.35 2026.9.7 2026.9.8 2026.9.10";
    const scenarios = "reported-issues";
    const groups = planTargetedDockerLaneGroups({
      lanes,
      upgradeSurvivorBaselines: baselines,
      upgradeSurvivorScenarios: scenarios,
    });
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
    ]).toEqual([
      "openclaw@2026.9.10",
      "openclaw@2026.9.8",
      "openclaw@2026.9.7",
      "openclaw@2026.8.35",
      "openclaw@2026.6.34",
    ]);
    const actual = groups.flatMap((group) =>
      expandedPlan(
        group.docker_lanes,
        group.published_upgrade_survivor_baselines ?? baselines,
        group.published_upgrade_survivor_scenarios ?? scenarios,
      ).scheduledLanes.map((lane) => lane.name),
    );
    const expected = expandedPlan(lanes, baselines, scenarios).scheduledLanes.map(
      (lane) => lane.name,
    );
    expect(actual.toSorted()).toEqual(expected.toSorted());
    expect(new Set(actual).size).toBe(actual.length);
  });

  it("isolates the weekly mobile and watch scenarios by baseline", () => {
    const baselines = "2026.7.1 2026.8.1";
    const scenarios = "mobile-pairing-reconnect watchos-direct-node";
    const groups = planTargetedDockerLaneGroups({
      lanes: "update-migration",
      upgradeSurvivorBaselines: baselines,
      upgradeSurvivorScenarios: scenarios,
    });
    const plans = groups.map((group) =>
      expandedPlan(
        group.docker_lanes,
        group.published_upgrade_survivor_baselines ?? baselines,
        group.published_upgrade_survivor_scenarios ?? scenarios,
      ),
    );

    expect(groups).toEqual([
      {
        docker_lanes: "update-migration",
        label: "update-migration-2026.8.1-scenarios-1",
        published_upgrade_survivor_baselines: "openclaw@2026.8.1",
        published_upgrade_survivor_scenarios: "mobile-pairing-reconnect",
        timeout_minutes: 90,
      },
      {
        docker_lanes: "update-migration",
        label: "update-migration-2026.8.1-scenarios-2",
        published_upgrade_survivor_baselines: "openclaw@2026.8.1",
        published_upgrade_survivor_scenarios: "watchos-direct-node",
        timeout_minutes: 90,
      },
      {
        docker_lanes: "update-migration",
        label: "update-migration-2026.7.1-scenarios-1",
        published_upgrade_survivor_baselines: "openclaw@2026.7.1",
        published_upgrade_survivor_scenarios: "mobile-pairing-reconnect",
        timeout_minutes: 90,
      },
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
    const groups = planTargetedDockerLaneGroups({
      groupSize: 2,
      lanes,
      upgradeSurvivorBaselines: baselines,
      upgradeSurvivorScenarios: scenarios,
    });
    const expanded = groups.map((group) => ({
      group,
      plan: expandedPlan(
        group.docker_lanes,
        group.published_upgrade_survivor_baselines ?? baselines,
        group.published_upgrade_survivor_scenarios ?? scenarios,
      ),
    }));
    const actual = expanded.flatMap(({ plan }) => plan.scheduledLanes);
    const expected = expandedPlan(lanes, baselines, scenarios).scheduledLanes;
    expect(actual.toSorted((left, right) => left.name.localeCompare(right.name))).toEqual(
      expected.toSorted((left, right) => left.name.localeCompare(right.name)),
    );
    expect(new Set(actual.map((lane) => lane.name)).size).toBe(actual.length);
    expect(new Set(groups.map((group) => group.label)).size).toBe(groups.length);
    for (const { group, plan } of expanded) {
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
      const groups = planTargetedDockerLaneGroups({
        lanes,
        upgradeSurvivorBaselines: baselines,
        upgradeSurvivorScenarios: scenarios,
      });
      const expanded = groups.map((group) =>
        expandedPlan(
          group.docker_lanes,
          group.published_upgrade_survivor_baselines ?? baselines,
          group.published_upgrade_survivor_scenarios ?? scenarios,
          targetRoot,
        ),
      );
      const expected = expandedPlan(lanes, baselines, scenarios, targetRoot);
      expect(
        expanded
          .flatMap((plan) => plan.scheduledLanes)
          .toSorted((left, right) => left.name.localeCompare(right.name)),
      ).toEqual(
        expected.scheduledLanes.toSorted((left, right) => left.name.localeCompare(right.name)),
      );
      expect(expanded.flatMap((plan) => plan.omittedUnsupportedLaneNames).toSorted()).toEqual(
        expected.omittedUnsupportedLaneNames.toSorted(),
      );
      for (const plan of expanded) {
        expect(
          plan.scheduledLanes.length + plan.omittedUnsupportedLaneNames.length,
        ).toBeGreaterThan(0);
      }
    });
  });
});
