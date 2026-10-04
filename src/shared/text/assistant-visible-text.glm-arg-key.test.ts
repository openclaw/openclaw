// GLM <tool_call>exec<arg_key> cases live beside assistant-visible-text.test.ts,
// which sits at the max-lines cap.
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
    [
      "Checking.\n<tool_call>read<arg_key>path</arg_key><arg_value>/tmp/x</arg_value></tool_call>",
      "Checking.\n",
    ],
    ["Checking.\n<tool_call>read\n<arg_key>name</arg_key>\n<arg_value>read", "Checking.\n"],
    ["Visible\n<tool_call>exec<arg_key>", "Visible\n"],
    ["Visible\n<tool_call>exec<arg_", "Visible\n"],
    ["Visible\n<tool_call>exec<arg_ke", "Visible\n"],
    ["Visible\n<tool_call>exec<arg_key>command</arg_", "Visible\n"],
    ["Visible\n<tool_call>exec<arg_key>command</arg", "Visible\n"],
    ["Visible\n<tool_call>exec<arg_key>command</", "Visible\n"],
    ["Visible\n<tool_call>exec<arg_key>command \n", "Visible\n"],
    [
      '<tool_call>exec<arg_key hint="a > b">command</arg_key><arg_value>private</arg_value></tool_call>',
      "",
    ],
    ["<tool_call>exec<ARG_KEY>command</ARG_KEY></tool_call>", ""],
    ["<tool_call>exec<arg_key>command</arg_key</tool_call>", ""],
    ["<tool_call>web-search<arg_key>query</arg_key><arg_value>private</arg_value></tool_call>", ""],
    ["<tool_call>exec<arg_key>command\n</arg_key><arg_value>private</arg_value></tool_call>", ""],
    ["<tool_call>exec<arg_key>\ncommand\n</arg_key><arg_value>private</arg_value></tool_call>", ""],
  ])("strips a GLM shadow payload: %s", (input, expected) => {
    expect(stripAssistantInternalScaffolding(input)).toBe(expected);
  });

  it.each([
    "Use <tool_call>exec",
    "Use <tool_call>exec ",
    "Use <tool_call>exec\n",
    "Use <tool_call>x",
    "Models emit exec<arg_key>command</arg_key> next to a structured tool call.",
    "Use <tool_call>exec<arg_key> literally.",
    "prefix <tool_call><arg_key>secret</arg_key></tool_call> suffix",
    "Use <tool_call>exec<arg_key> literally. Example: `</arg_key>`.",
    "Use <tool_call>exec<arg_key_extra> literally.",
    "Use <tool_call>exec<arg_key/> literally.",
    "Use <tool_call>exec<arg_key>command</argument> literally.",
    "Use <tool_call>exec<arg_key>command</arg_k</tool_call> literally.",
    "Use <tool_call>exec<arg_key>command literally. Example: `</arg_key>`.",
    "Use <tool_call>exec<arg_key>\ncommand literally. Example: `</arg_key>`.",
    "Use <tool_call>exec<arg_key>\ncommand",
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

  it("holds name-only and partial-key prefixes only while streaming", () => {
    for (const input of [
      "Visible\n<tool_call>exec",
      "Visible\n<tool_call>exec ",
      "Visible\n<tool_call>x",
    ]) {
      expect(sanitizeAssistantVisibleTextWithProfile(input, "delivery", true)).toBe("Visible");
    }
    for (const suffix of ["\n", "\ncommand", "\ncommand\n", "\ncommand\n</arg_"]) {
      expect(
        sanitizeAssistantVisibleTextWithProfile(
          `Visible\n<tool_call>exec<arg_key>${suffix}`,
          "delivery",
          true,
        ),
      ).toBe("Visible");
    }
  });
});
