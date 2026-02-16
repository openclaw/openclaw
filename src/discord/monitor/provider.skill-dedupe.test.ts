import { describe, expect, it } from "vitest";
import { __testing } from "./provider.js";

describe("dedupeSkillCommandsForDiscord", () => {
  it("keeps first command per skillName and drops suffix duplicates", () => {
    const input = [
      { name: "github", skillName: "github", description: "GitHub" },
      { name: "github_2", skillName: "github", description: "GitHub" },
      { name: "weather", skillName: "weather", description: "Weather" },
      { name: "weather_2", skillName: "weather", description: "Weather" },
    ];

    const output = __testing.dedupeSkillCommandsForDiscord(input);
    expect(output.map((entry) => entry.name)).toEqual(["github", "weather"]);
  });

  it("treats skillName case-insensitively", () => {
    const input = [
      { name: "NeoHub", skillName: "NeoHub", description: "NeoHub" },
      { name: "neohub_2", skillName: "neohub", description: "NeoHub" },
    ];
    const output = __testing.dedupeSkillCommandsForDiscord(input);
    expect(output).toHaveLength(1);
    expect(output[0]?.name).toBe("NeoHub");
  });
});
