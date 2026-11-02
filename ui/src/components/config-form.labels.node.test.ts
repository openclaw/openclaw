import { describe, expect, it } from "vitest";
import { humanizeConfigEnumValue, sentenceCaseConfigLabel } from "./config-form.labels.ts";

describe("sentenceCaseConfigLabel", () => {
  it.each([
    ["Outbound Response Prefix", "Outbound response prefix"],
    ["Browser Profile CDP Port", "Browser profile CDP port"],
    ["Browser No-Sandbox Mode", "Browser no-sandbox mode"],
    ["MS Teams Config Writes", "MS Teams config writes"],
    ["Enable Native Codex Web Search", "Enable native Codex web search"],
    ["Pdf Model", "PDF model"],
    ["Provider Usage Cache TTL (ms)", "Provider usage cache TTL (ms)"],
    ["Log level", "Log level"],
    ["iMessage Group Policy", "iMessage group policy"],
  ])("%s reads as %s", (label, expected) => {
    expect(sentenceCaseConfigLabel(label)).toBe(expected);
  });
});

describe("humanizeConfigEnumValue", () => {
  it.each([
    ["merge", "Merge"],
    ["message_tool", "Message tool"],
    ["group-mentions", "Group mentions"],
    ["streamable-http", "Streamable HTTP"],
    ["openai-responses", "OpenAI responses"],
    ["dm", "DM"],
  ])("%s reads as %s", (value, expected) => {
    expect(humanizeConfigEnumValue(value)).toBe(expected);
  });

  it.each(["SOUL.md", "operator.admin", "0600", "*", "USGovDoD", "Public"])(
    "leaves %s, which is not an identifier word, as written",
    (value) => {
      expect(humanizeConfigEnumValue(value)).toBe(value);
    },
  );
});
