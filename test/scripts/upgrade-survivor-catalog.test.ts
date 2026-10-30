import { describe, expect, it } from "vitest";
import {
  parseUpgradeSurvivorScenarios,
  readUpgradeSurvivorScenarioCatalog,
  supportsUpgradeSurvivorScenarioAtBaseline,
} from "../../scripts/lib/upgrade-survivor-policy.mjs";

const scenarios = { scenarios: ["base"], assertionOnlyScenarios: ["codex-allowlist-survival"] };
describe("inert upgrade-survivor catalog", () => {
  it("keeps the shipped group-only fixture explicit and pinned to its audited baseline", () => {
    expect(parseUpgradeSurvivorScenarios("session-share")).toEqual(["session-share"]);
    expect(parseUpgradeSurvivorScenarios("far-reaching")).not.toContain("session-share");
    expect(parseUpgradeSurvivorScenarios("reported-issues")).not.toContain("session-share");
    expect(supportsUpgradeSurvivorScenarioAtBaseline("session-share", "openclaw@2026.10.7")).toBe(
      true,
    );
    for (const baseline of ["openclaw@latest", "openclaw@2026.9.7", "openclaw@2026.10.6"]) {
      expect(supportsUpgradeSurvivorScenarioAtBaseline("session-share", baseline)).toBe(false);
    }
  });
  it.each([{}, { oldestSupportedBaseline: "2026.6.34" }, { oldestSupportedBaseline: null }])(
    "reads historical and candidate-owned catalog data: %j",
    (extra) => {
      expect(
        readUpgradeSurvivorScenarioCatalog(JSON.stringify({ ...scenarios, ...extra })),
      ).toEqual(["base", "codex-allowlist-survival"]);
    },
  );
  it.each([
    { oldestSupportedBaseline: "latest" },
    { oldestSupportedBaseline: "2026.9.7-beta.1" },
    { oldestSupportedBaseline: " 2026.6.34" },
    { oldestSupportedBaseline: 2026 },
    { oldestSupportedBaseline: {} },
    { oldestSupportedBaseline: "2026.6.34", extra: true },
    { extra: true },
    { scenarios: [] },
    { scenarios: ["base", "base"] },
    { assertionOnlyScenarios: ["base"] },
    { scenarios: ["process.exit(0)"] },
  ])("refuses undeclared or malformed catalog data: %j", (extra) => {
    expect(
      readUpgradeSurvivorScenarioCatalog(JSON.stringify({ ...scenarios, ...extra })),
    ).toBeUndefined();
  });
});
