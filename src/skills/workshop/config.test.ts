import { describe, expect, it } from "vitest";
import { resolveSkillWorkshopConfig } from "./config.js";
import { workshopPluginConfig } from "./config.test-support.js";

describe("resolveSkillWorkshopConfig", () => {
  it("defaults autonomous learning to auto with channel notices off", () => {
    expect(resolveSkillWorkshopConfig().autonomous).toEqual({
      mode: "auto",
      channelNotices: false,
    });
  });

  it.each([false, true])("reads channel notices %s", (channelNotices) => {
    expect(
      resolveSkillWorkshopConfig(workshopPluginConfig({ autonomous: { channelNotices } }))
        .autonomous.channelNotices,
    ).toBe(channelNotices);
  });

  it.each(["off", "propose", "auto"] as const)("reads autonomous mode %s", (mode) => {
    expect(
      resolveSkillWorkshopConfig(workshopPluginConfig({ autonomous: { mode } })).autonomous.mode,
    ).toBe(mode);
  });

  it("does not read the retired core key at runtime", () => {
    expect(
      resolveSkillWorkshopConfig({
        skills: { workshop: { autonomous: { mode: "off" } } },
      } as never).autonomous.mode,
    ).toBe("auto");
  });
});
