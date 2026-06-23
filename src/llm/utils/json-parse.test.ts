// JSON parse tests cover tolerant parsing of partial model JSON output.
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

  it.each([
    ['{"path":"C:\\bin\\app.exe"}', "C:\\bin\\app.exe"],
    ['{"path":"C:\\temp\\x"}', "C:\\temp\\x"],
    ['{"path":"C:\\new\\file"}', "C:\\new\\file"],
    ['{"path":"D:\\reports\\q"}', "D:\\reports\\q"],
    ['{"path":"C:\\users\\bob"}', "C:\\users\\bob"],
  ])("preserves unescaped Windows path control-letter segments: %s", (input, expected) => {
    expect(parseStreamingJson(input)).toEqual({ path: expected });
    expect(parseJsonWithRepair(input)).toEqual({ path: expected });
  });

  it("preserves legitimate JSON control escapes outside Windows paths", () => {
    expect(parseJsonWithRepair('{"message":"line\\nnext\\ttabbed"}')).toEqual({
      message: "line\nnext\ttabbed",
    });
  });

  it("recovers streaming tool-call arguments instead of dropping them to {}", () => {
    // LaTeX-style \u (\underline) is a valid string value the model may emit in args.
    const args = '{"cmd":"\\underline{x}"}';
    expect(parseStreamingJson(args)).toEqual({ cmd: "\\underline{x}" });
  });

  it.each(["null", "[]", '"text"', "1", "true"])(
    "returns an empty object for non-object streaming JSON: %s",
    (input) => {
      expect(parseStreamingJson(input)).toEqual({});
    },
  );
});

describe("json-parse repairJson Windows-path false positives (issue #93139)", () => {
  // Before the code-context guard, the Windows-path heuristic matched any
  // tail ending in `<non-alphanum><letter>:` — which also matches Python
  // block openers like `if x:`, `for x:`, `try:`, `def foo(x):` — and the
  // newline immediately after the colon got rewritten as a literal `\\n`
  // instead of an actual newline. That broke any agent tool call carrying
  // multi-line Python in a heredoc, with the symptom that the shell saw a
  // line-continuation character and refused to run the script.

  it.each([
    [
      "Python if-block in a heredoc",
      '{"command": "python3 << EOF\\nif x:\\n    print(1)\\nEOF"}',
      "python3 << EOF\nif x:\n    print(1)\nEOF",
    ],
    [
      "Python try/except",
      '{"command": "try:\\n    foo()\\nexcept Exception as e:\\n    bar()"}',
      "try:\n    foo()\nexcept Exception as e:\n    bar()",
    ],
    [
      "Python def with parens in the signature",
      '{"command": "def foo(x):\\n    return x"}',
      "def foo(x):\n    return x",
    ],
    ["Python while-True loop", '{"command": "while True:\\n    break"}', "while True:\n    break"],
    [
      "reproducer reported in #93139 (if r:)",
      '{"command": "r = re.match(p, s)\\nif r:\\n    print(r)"}',
      "r = re.match(p, s)\nif r:\n    print(r)",
    ],
    [
      "bash for-loop with shell redirect in prior context",
      '{"command": "for f in *.py:\\n  echo $f"}',
      "for f in *.py:\n  echo $f",
    ],
  ])("preserves real newlines after Python/shell block openers: %s", (_name, input, expected) => {
    expect(parseJsonWithRepair(input)).toEqual({ command: expected });
    expect(parseStreamingJson(input)).toEqual({ command: expected });
  });

  it("still preserves a Windows path that appears alongside code", () => {
    // Confirms the guard is scoped: the path part stays escaped, the code
    // part gets real newlines. Both parts of the same string survive.
    const input = '{"text": "see C:\\\\Users for path; if x:\\n    do_stuff()"}';
    expect(parseJsonWithRepair(input)).toEqual({
      text: "see C:\\Users for path; if x:\n    do_stuff()",
    });
  });
});
