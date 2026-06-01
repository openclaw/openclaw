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

  it("keeps control-escape letters literal in unescaped Windows paths", () => {
    const cases = [
      ['{"path":"C:\\bin\\app.exe"}', "C:\\bin\\app.exe"],
      ['{"path":"C:\\temp\\x"}', "C:\\temp\\x"],
      ['{"path":"C:\\new\\file"}', "C:\\new\\file"],
      ['{"path":"D:\\reports\\q"}', "D:\\reports\\q"],
      ['{"path":"C:\\users\\bob"}', "C:\\users\\bob"],
    ];

    for (const [args, path] of cases) {
      expect(parseStreamingJson(args)).toEqual({ path });
    }
  });

  it("preserves ordinary JSON control escapes outside Windows paths", () => {
    expect(parseJsonWithRepair('{"message":"hello\\nworld"}')).toEqual({
      message: "hello\nworld",
    });
  });
});
