import { describe, expect, it } from "vitest";
import {
  CLAWHUB_RECOMMENDATIONS_CHANNEL_DATA_KEY,
  type ClawHubRecommendation,
  readClawHubRecommendations,
} from "./clawhub-recommendations.js";

describe("readClawHubRecommendations", () => {
  it("preserves accepted and rejected cards and their serialized field order", () => {
    const plugin = {
      type: "clawhub",
      id: `ch_${"p".repeat(300)}`,
      name: "Calendar",
      installed: false,
      official: true,
      kind: "plugin",
    } satisfies ClawHubRecommendation;
    const skill = {
      type: "clawhub",
      id: "@openclaw/calendar",
      name: "Calendar skill",
      installed: true,
      official: true,
      kind: "skill",
      registry: "https://clawhub.ai",
      skillRef: "@openclaw/calendar",
    } satisfies ClawHubRecommendation;
    const cases: Array<{ value: unknown; expected: ClawHubRecommendation[] }> = [
      { value: undefined, expected: [] },
      { value: null, expected: [] },
      { value: [], expected: [] },
      { value: [plugin, skill, plugin], expected: [plugin, skill, plugin] },
      { value: [plugin, skill, plugin, skill], expected: [] },
      { value: [{ ...plugin, official: false }], expected: [] },
      { value: [{ ...plugin, extra: true }], expected: [] },
      { value: [{ ...skill, skillRef: "@another/calendar" }], expected: [] },
    ];
    const read = (value: unknown) =>
      readClawHubRecommendations({ [CLAWHUB_RECOMMENDATIONS_CHANNEL_DATA_KEY]: value });
    for (const { value, expected } of cases) {
      const cards = read(value);
      expect(cards).toEqual(expected);
      expect(JSON.stringify(cards)).toBe(JSON.stringify(expected));
    }

    expect(readClawHubRecommendations(undefined)).toEqual([]);
  });
});
