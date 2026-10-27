import { describe, expect, it } from "vitest";
import { readUpgradeSurvivorScenarioCatalog } from "../../scripts/lib/upgrade-survivor-policy.mjs";

const scenarios = { scenarios: ["base"], assertionOnlyScenarios: ["codex-allowlist-survival"] };
describe("inert upgrade-survivor catalog", () => {
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
