import { describe, expect, it } from "vitest";
import { parseJsonWithRepair, parseStreamingJson, repairJson } from "./json-parse.js";

describe("json-parse repairJson invalid \\u escapes", () => {
  it("repairs a \\u not followed by four hex digits so the result parses", () => {
    // JS string is: {"path":"C:\users"} — a model emitting an unescaped Windows path.
    const broken = '{"path":"C:\\users"}';
    expect(() => JSON.parse(repairJson(broken))).not.toThrow();
    expect(parseJsonWithRepair(broken)).toEqual({ path: "C:\\users" });
  });

  it("preserves valid \\uXXXX escapes", () => {
    expect(parseJsonWithRepair('{"e":"\\u0041"}')).toEqual({ e: "A" });
  });

  it("recovers streaming tool-call arguments instead of dropping them to {}", () => {
    // LaTeX-style \u (\underline) is a valid string value the model may emit in args.
    const args = '{"cmd":"\\underline{x}"}';
    expect(parseStreamingJson(args)).toEqual({ cmd: "\\underline{x}" });
  });

  it.each([
    ['{"path":"C:\\bin\\app.exe"}', "C:\\bin\\app.exe"],
    ['{"path":"C:\\temp\\x"}', "C:\\temp\\x"],
    ['{"path":"C:\\new\\file"}', "C:\\new\\file"],
    ['{"path":"D:\\reports\\q"}', "D:\\reports\\q"],
    ['{"path":"C:\\users\\bob"}', "C:\\users\\bob"],
  ])("keeps unescaped Windows path control-letter segments literal for %s", (args, path) => {
    expect(parseStreamingJson(args)).toEqual({ path });
  });

  it("normalizes decoded Windows path escapes in nested tool arguments", () => {
    expect(parseStreamingJson('{"edits":[{"path":"C:\\new\\file"}]}')).toEqual({
      edits: [{ path: "C:\\new\\file" }],
    });
  });

  it("normalizes decoded Windows path escapes after mixed separators in path fields", () => {
    expect(parseStreamingJson('{"path":"C:/tmp\\new.txt"}')).toEqual({
      path: "C:/tmp\\new.txt",
    });
  });

  it("does not rewrite legitimate non-path control escapes", () => {
    expect(parseStreamingJson('{"message":"first\\nsecond"}')).toEqual({
      message: "first\nsecond",
    });
  });

  it("does not rewrite non-path content that starts with a drive prefix", () => {
    expect(parseStreamingJson('{"content":"C:/\\nnext"}')).toEqual({
      content: "C:/\nnext",
    });
    expect(parseStreamingJson('{"content":"C:\\nnext"}')).toEqual({
      content: "C:\nnext",
    });
  });
});
