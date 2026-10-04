import { describe, expect, it } from "vitest";
import { stripSessionTitleAddressing } from "./session-title-source.js";

describe("stripSessionTitleAddressing", () => {
  it.each([
    ["Slack mention with display name", "<@U0BNFBKJB7B> (ohmybot) Review the Nature paper"],
    ["Slack mention with label", "<@U0BNFBKJB7B|ohmybot> Review the Nature paper"],
    ["repeated addressees", "<@U0BNFBKJB7B> (ohmybot) <!here>: Review the Nature paper"],
    ["Discord mention", "<@!123456789> Review the Nature paper"],
    ["plain-text handle", "@ohmybot, Review the Nature paper"],
  ])("drops a leading %s", (_name, text) => {
    expect(stripSessionTitleAddressing(text)).toBe("Review the Nature paper");
  });

  it("keeps a readable name for mid-sentence mentions", () => {
    expect(
      stripSessionTitleAddressing("Ask <@U0ALICE01> (Alice) and <@U0BOB0001|bob> to review"),
    ).toBe("Ask @Alice and @bob to review");
  });

  it("drops unnamed mid-sentence transport ids", () => {
    expect(stripSessionTitleAddressing("Loop in <@U0ALICE01> on the rollout")).toBe(
      "Loop in on the rollout",
    );
  });

  it("leaves ordinary text, package names, and parenthetical topics intact", () => {
    expect(stripSessionTitleAddressing("@types/node upgrade (urgent)")).toBe(
      "@types/node upgrade (urgent)",
    );
    expect(stripSessionTitleAddressing("Email alice@example.com about <tags>")).toBe(
      "Email alice@example.com about <tags>",
    );
  });

  it("returns empty text when only addressing remains", () => {
    expect(stripSessionTitleAddressing("  <@U0BNFBKJB7B> (ohmybot)  ")).toBe("");
  });
});
