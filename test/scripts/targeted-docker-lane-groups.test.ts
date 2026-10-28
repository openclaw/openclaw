import { expect, it } from "vitest";
import { planTargetedDockerLaneGroups } from "../../scripts/plan-targeted-docker-lane-groups.mjs";

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
const cells = (groups: Group[]) =>
  groups.map((group) => [
    group.published_upgrade_survivor_baselines,
    group.published_upgrade_survivor_scenarios,
  ]);

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
  expect(groups.every((group) => group.docker_lanes === "published-upgrade-survivor")).toBe(true);
  expect(cells(groups)).toEqual([
    ["openclaw@2026.9.3", "base"],
    ["openclaw@2026.9.3", "legacy-operator-state"],
    ["openclaw@2026.9.4", "custom-plugin-siblings"],
  ]);
});

it("retains 256 groups and explicitly rejects matrix overflow without dropping coverage", () => {
  const baselines = Array.from({ length: 256 }, (_, index) => `2026.9.${index + 1}`).join(" ");
  expect(planGroups("update-migration", baselines)).toHaveLength(256);
  expect(() => planGroups("update-migration install-smoke", baselines)).toThrow(
    "257 jobs, exceeding the GitHub Actions matrix limit of 256",
  );
});

it("requires an exact predecessor for supported-line pairing", () => {
  expect(() =>
    planGroups("published-upgrade-survivor", "2026.9.2 2026.9.1", "base legacy-operator-state", {
      upgradeSurvivorBaselineScope: "legacy-operator-state",
    }),
  ).toThrow("requires an exact published predecessor");
});

it("does not schedule a first-hop member twice beside its family", () => {
  const family = planGroups("update-first-hop-compat");
  expect(family.length).toBeGreaterThan(1);
  expect(planGroups(`${family[0]!.docker_lanes} update-first-hop-compat`)).toEqual(family);
});

it("shards published upgrade survivor by baseline while preserving surrounding lanes", () => {
  const groups = planGroups(
    "doctor-switch update-channel-switch published-upgrade-survivor plugins-offline plugin-update",
    "openclaw@2026.6.11-1 openclaw@2026.6.11",
    "",
    { groupSize: 2 },
  );
  expect(groups.map((group) => group.docker_lanes)).toEqual([
    "doctor-switch update-channel-switch",
    "published-upgrade-survivor",
    "published-upgrade-survivor",
    "plugins-offline plugin-update",
  ]);
  expect(groups.slice(1, 3).map((group) => group.published_upgrade_survivor_baselines)).toEqual([
    "openclaw@2026.6.11-1",
    "openclaw@2026.6.11",
  ]);
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
});

it("isolates the weekly mobile and watch scenarios by baseline", () => {
  const baselines = "2026.7.1 2026.8.1";
  const scenarios = "mobile-pairing-reconnect watchos-direct-node";
  const groups = planGroups("update-migration", baselines, scenarios);
  expect(groups.every((group) => group.docker_lanes === "update-migration")).toBe(true);
  expect(cells(groups)).toEqual([
    ["openclaw@2026.8.1", "mobile-pairing-reconnect"],
    ["openclaw@2026.8.1", "watchos-direct-node"],
    ["openclaw@2026.7.1", "mobile-pairing-reconnect"],
  ]);
});

it.each([
  {
    label: "the default baseline",
    baselines: "",
    scenarios: "base legacy-operator-state",
    count: 6,
  },
  {
    label: "recovery-only rows",
    baselines: "2026.10.1",
    scenarios:
      "package-publication-recovery package-verification-recovery package-stranded-first-hop",
    count: 12,
  },
])("preserves each expanded lane exactly once for $label", ({ baselines, scenarios, count }) => {
  const lanes = "doctor-switch published-upgrade-survivor update-migration plugin-update";
  const groups = planGroups(lanes, baselines, scenarios, { groupSize: 2 });
  expect(groups).toHaveLength(count);
  expect(new Set(groups.map((group) => group.label)).size).toBe(groups.length);
  expect(
    new Set(groups.map((group) => JSON.stringify([group.docker_lanes, ...cells([group])[0]!])))
      .size,
  ).toBe(groups.length);
  expect(
    [
      ...new Set(
        groups.flatMap((group) => group.published_upgrade_survivor_scenarios?.split(" ") ?? []),
      ),
    ].toSorted(),
  ).toEqual(scenarios.split(" ").toSorted());
  for (const group of groups) {
    if (/^(?:published-upgrade-survivor|update-migration)(?:$|-)/u.test(group.docker_lanes)) {
      expect(group.published_upgrade_survivor_scenarios?.split(" ")).toHaveLength(1);
      expect(group.timeout_minutes).toBe(90);
    }
  }
});
