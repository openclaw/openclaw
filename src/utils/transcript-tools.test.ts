// Transcript tool tests cover transcript utility parsing and formatting.
import { describe, expect, it } from "vitest";
import { countToolResults, extractToolCallNames } from "./transcript-tools.js";

describe("transcript-tools", () => {
  describe("extractToolCallNames", () => {
    it("extracts tool name from message.toolName/tool_name", () => {
      expect(extractToolCallNames({ toolName: " weather " })).toEqual(["weather"]);
      expect(extractToolCallNames({ tool_name: "notes" })).toEqual(["notes"]);
    });

    it("extracts tool call names from supported content blocks", () => {
      const names = extractToolCallNames({
        content: [
          { type: "text", text: "hi" },
          { type: "tool_use", name: "read" },
          { type: "toolcall", name: "exec" },
          { type: "tool_call", name: "write" },
          { type: " toolCall ", name: "padded" },
          { type: "toolUse", name: "legacy" },
        ],
      });
      expect(names).toEqual(["read", "exec", "write", "padded", "legacy"]);
    });

    it.each([
      ["distinct IDs", "call-1", "call-2"],
      ["reused IDs", "call-1", "call-1"],
      ["missing IDs", undefined, undefined],
    ])("counts repeated names with %s after the top-level mirror", (_label, firstId, secondId) => {
      const names = extractToolCallNames({
        content: [
          { type: " TOOL_CALL ", id: firstId, name: "  read " },
          { type: "tool_call", id: secondId, name: "read" },
          { type: "tool_call", name: "" },
        ],
        toolName: "read",
      });
      expect(names).toEqual(["read", "read"]);
    });

    it("preserves top-level alias precedence and skips only its first matching block", () => {
      expect(
        extractToolCallNames({
          toolName: " write ",
          tool_name: "ignored",
          content: [
            { type: "toolCall", name: "read" },
            { type: "toolUse", name: "write" },
            { type: "tooluse", name: "write" },
          ],
        }),
      ).toEqual(["write", "read", "write"]);
      expect(extractToolCallNames({ toolName: " ", tool_name: "ignored", content: [] })).toEqual(
        [],
      );
    });
  });

  describe("countToolResults", () => {
    it("counts tool_result blocks and tool_result_error blocks; tracks errors via is_error", () => {
      expect(
        countToolResults({
          content: [
            { type: "tool_result" },
            { type: "tool_result", is_error: true },
            { type: "tool_result_error" },
            { type: "text", text: "ignore" },
          ],
        }),
      ).toEqual({ total: 3, errors: 1 });
    });

    it("handles non-array content", () => {
      expect(countToolResults({ content: "nope" })).toEqual({ total: 0, errors: 0 });
    });
  });
});
