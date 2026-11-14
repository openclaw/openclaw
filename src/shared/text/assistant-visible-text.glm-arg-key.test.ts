import { describe, expect, it } from "vitest";
import {
  sanitizeAssistantVisibleText,
  sanitizeAssistantVisibleTextWithProfile,
  stripAssistantInternalScaffolding,
  stripToolCallXmlTags,
} from "./assistant-visible-text.js";

const SHADOW =
  "<tool_call>exec<arg_key>command</arg_key><arg_value>echo redacted</arg_value></tool_call>";

describe("GLM arg_key assistant text", () => {
  it.each([
    [
      "<tool_call>exec<arg_key>command</arg_key><arg_value>cd /tmp && gh pr list</arg_value><arg_key>timeout</arg_key><arg_value>30</arg_value></tool_call>",
      "",
    ],
    ["Visible\n<tool_call>exec<arg_ke", "Visible\n"],
    ["Visible\n<tool_call>exec<arg_key>command</", "Visible\n"],
  ])("strips a GLM shadow payload: %s", (input, expected) => {
    expect(stripAssistantInternalScaffolding(input)).toBe(expected);
  });

  it.each([
    "Models emit exec<arg_key>command</arg_key> next to a structured tool call.",
    "Use <tool_call>exec<arg_key/> literally.",
    "Use <tool_call>exec<arg_key> \n</arg_key> literally.",
  ])("keeps literal prose: %s", (input) => {
    expect(stripAssistantInternalScaffolding(input)).toBe(input);
  });

  it("keeps the public XML helper terminal-only", () => {
    expect(stripToolCallXmlTags("Use <tool_call>exec ")).toBe("Use <tool_call>exec ");
  });

  it("trims a finished delivery marker without borrowing a later close", () => {
    expect(sanitizeAssistantVisibleText(SHADOW)).toBe("");
    expect(sanitizeAssistantVisibleText("Use <tool_call>exec ")).toBe("Use <tool_call>exec");
    expect(sanitizeAssistantVisibleText("Use <tool_call><arg> literally.")).toBe(
      "Use <tool_call><arg> literally.",
    );
    expect(
      sanitizeAssistantVisibleText(
        "Use <tool_call>exec<arg_key> literally. Example: `</arg_key>`.",
      ),
    ).toBe("Use <tool_call>exec<arg_key> literally. Example: `</arg_key>`.");
  });

  it.each([
    "Visible\n<tool_call>exec",
    "Visible\n<tool_call>exec ",
    "Visible\n<tool_call>x",
    ...["\n", "\ncommand", "\ncommand\n", "\ncommand\n</arg_"].map(
      (suffix) => `Visible\n<tool_call>exec<arg_key>${suffix}`,
    ),
  ])("holds name-only and partial-key prefixes only while streaming: %j", (input) => {
    expect(sanitizeAssistantVisibleTextWithProfile(input, "delivery", true)).toBe("Visible");
  });
});

describe("invocation XML", () => {
  const invocation =
    '<invoke name="exec"><parameter name="command">echo hidden</parameter></invoke>';

  it("strips invocation blocks without allowing literal parameter tags to swallow prose", () => {
    const input =
      '<invoke name="exec"><parameter name="command">echo \'<parameter>\'</parameter></invoke>' +
      "The answer is 42.\n" +
      '<invoke name="exec"><parameter name="command">echo \'</parameter>\'</parameter></invoke>';
    expect(sanitizeAssistantVisibleText(input)).toBe("The answer is 42.");
  });

  it.each([`    ${invocation}`, `Use ${invocation} in an example.`])(
    "preserves a literal invocation example %s",
    (example) => {
      expect(sanitizeAssistantVisibleText(example)).toBe(example);
    },
  );
});
