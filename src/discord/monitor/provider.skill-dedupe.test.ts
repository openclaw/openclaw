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
      { name: "ClawHub", skillName: "ClawHub", description: "ClawHub" },
      { name: "clawhub_2", skillName: "clawhub", description: "ClawHub" },
    ];
    const output = __testing.dedupeSkillCommandsForDiscord(input);
    expect(output).toHaveLength(1);
    expect(output[0]?.name).toBe("ClawHub");
  });
});

describe("resolveThreadBindingsEnabled", () => {
  it("defaults to enabled when unset", () => {
    expect(
      __testing.resolveThreadBindingsEnabled({
        channelEnabledRaw: undefined,
        sessionEnabledRaw: undefined,
      }),
    ).toBe(true);
  });

  it("uses global session default when channel value is unset", () => {
    expect(
      __testing.resolveThreadBindingsEnabled({
        channelEnabledRaw: undefined,
        sessionEnabledRaw: false,
      }),
    ).toBe(false);
  });

  it("uses channel value to override global session default", () => {
    expect(
      __testing.resolveThreadBindingsEnabled({
        channelEnabledRaw: true,
        sessionEnabledRaw: false,
      }),
    ).toBe(true);
    expect(
      __testing.resolveThreadBindingsEnabled({
        channelEnabledRaw: false,
        sessionEnabledRaw: true,
      }),
    ).toBe(false);
  });
});
