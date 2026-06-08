import { describe, expect, it } from "vitest";
import { resolveDirectControlLanePriority } from "./control-lane-priority.js";

describe("resolveDirectControlLanePriority", () => {
  it("treats direct manual overrides as interrupt control-lane messages", () => {
    expect(
      resolveDirectControlLanePriority({
        text: "Ich habe sie manuell eingeschaltet.",
        chatType: "direct",
      }),
    ).toEqual({ queueMode: "interrupt", reason: "manual_override" });
  });

  it("treats direct urgent need messages as interrupt control-lane messages", () => {
    expect(
      resolveDirectControlLanePriority({
        text: "Ich brauche das jetzt gerade.",
        chatType: "direct",
      }),
    ).toEqual({ queueMode: "interrupt", reason: "urgent_need" });
  });

  it("does not classify group or ordinary direct text", () => {
    expect(
      resolveDirectControlLanePriority({
        text: "Ich habe sie manuell eingeschaltet.",
        chatType: "group",
      }),
    ).toBeUndefined();
    expect(
      resolveDirectControlLanePriority({
        text: "Kannst du später mal die Mails prüfen?",
        chatType: "direct",
      }),
    ).toBeUndefined();
  });
});
