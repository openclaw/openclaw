import { expect, it } from "vitest";
import { installedRecoveryLaneNames } from "../../scripts/e2e/lib/upgrade-survivor/installed-recovery-cases.mjs";
import { parseLaneSelection } from "../../scripts/lib/docker-e2e-plan.mts";
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

it("runs packaged older-runtime recovery once without historical baseline fan-out", () => {
  const lane = "package-installed-recovery-older-runtime";
  const groups = planGroups(lane, "2026.9.3 2026.9.4", "base legacy-operator-state");
  expect(groups).toEqual([{ docker_lanes: lane, label: lane }]);
});

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
    ["openclaw@2026.9.3", "legacy-operator-state"],
    ["openclaw@2026.9.3", "base"],
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

it("plans all seven installed recovery cells once as separate unchanged-budget jobs", () => {
  const mixed = `package-installed-recovery ${installedRecoveryLaneNames[0]}`;
  expect(planGroups(mixed)).toEqual(
    installedRecoveryLaneNames.map((lane) => ({ docker_lanes: lane, label: lane })),
  );
  expect(parseLaneSelection(mixed)).toEqual(installedRecoveryLaneNames);
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

it.each([32, 48, 64])(
  "preserves complete CLI rows and scopes tool-bridge priority at cap %i",
  async (maxParallel) => {
    const { execFileSync } = await import("node:child_process");
    const groups: Group[] = JSON.parse(
      execFileSync(process.execPath, ["scripts/plan-targeted-docker-lane-groups.mjs"], {
        encoding: "utf8",
        env: {
          ...process.env,
          LANES:
            "doctor-switch published-upgrade-survivor update-first-hop-compat-2026.9.2 update-first-hop-compat-2026.9.1 root-managed-vps-upgrade update-restart-auth plugins-offline plugin-update",
          GROUP_SIZE: "1",
          MAX_PARALLEL: String(maxParallel),
          OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SCOPE: "all-scenarios",
          OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS: "2026.9.3 2026.9.4",
          OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS:
            "base legacy-operator-state package-publication-recovery package-verification-recovery acpx-openclaw-tools-bridge",
        },
      }),
    );
    const lane = (name: string) => ({ docker_lanes: name, label: name });
    const scenario = (version: string, name: string, index: number) => ({
      docker_lanes: "published-upgrade-survivor",
      label: `published-upgrade-survivor-${version}-scenarios-${index}`,
      published_upgrade_survivor_baselines: `openclaw@${version}`,
      published_upgrade_survivor_scenarios: name,
      timeout_minutes: 90,
    });
    const recovery = (version: string, name: string) => ({
      ...lane(`published-upgrade-survivor-${version}-${name}`),
      published_upgrade_survivor_baselines: `openclaw@${version}`,
      published_upgrade_survivor_scenarios: name,
      timeout_minutes: 90,
    });
    expect(groups).toEqual([
      recovery("2026.9.8", "package-verification-recovery"),
      recovery("2026.9.9", "package-verification-recovery"),
      recovery("2026.9.8", "package-publication-recovery"),
      recovery("2026.9.9", "package-publication-recovery"),
      lane("update-first-hop-compat-2026.9.2"),
      lane("update-first-hop-compat-2026.9.1"),
      { ...lane("update-restart-auth"), timeout_minutes: 75 },
      lane("plugin-update"),
      ...(maxParallel === 64
        ? [
            scenario("2026.9.4", "acpx-openclaw-tools-bridge", 3),
            scenario("2026.9.3", "acpx-openclaw-tools-bridge", 3),
          ]
        : []),
      scenario("2026.9.4", "legacy-operator-state", 2),
      scenario("2026.9.3", "legacy-operator-state", 2),
      lane("root-managed-vps-upgrade"),
      lane("doctor-switch"),
      scenario("2026.9.4", "base", 1),
      ...(maxParallel !== 64 ? [scenario("2026.9.4", "acpx-openclaw-tools-bridge", 3)] : []),
      scenario("2026.9.3", "base", 1),
      ...(maxParallel !== 64 ? [scenario("2026.9.3", "acpx-openclaw-tools-bridge", 3)] : []),
      lane("plugins-offline"),
    ]);
  },
);

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
