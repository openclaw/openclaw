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

describe("json-parse trailing-space key stripping", () => {
  it("strips trailing spaces from top-level keys via parseJsonWithRepair", () => {
    // Simulates model output where partial-json parser accepts keys with trailing spaces.
    const input = '{"name":"test","schedule ":{"kind":"cron"},"enabled ":true}';
    // JSON.parse rejects this, but partial-json accepts it.
    const { parse } = require("partial-json");
    const parsed = parse(input);
    // Verify partial-json actually produces the trailing-space keys.
    expect(Object.keys(parsed)).toContain("schedule ");
    // parseStreamingJson should strip them.
    const result = parseStreamingJson(input);
    expect(result).toEqual({ name: "test", schedule: { kind: "cron" }, enabled: true });
    expect(Object.keys(result)).not.toContain("schedule ");
    expect(Object.keys(result)).not.toContain("enabled ");
  });

  it("strips trailing spaces from nested object keys", () => {
    const input = '{"job":{"schedule ":{"expr ":"30 10 * * *"}}}';
    const result = parseStreamingJson(input);
    expect(result).toEqual({ job: { schedule: { expr: "30 10 * * *" } } });
  });

  it("handles mixed clean and trailing-space keys", () => {
    const input =
      '{"name":"Holiday","description":"test","schedule ":{"kind":"cron"},"sessionTarget ":"isolated","payload ":{"kind":"agentTurn"},"enabled ":true}';
    const result = parseStreamingJson(input);
    expect(result).toEqual({
      name: "Holiday",
      description: "test",
      schedule: { kind: "cron" },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn" },
      enabled: true,
    });
  });

  it("does not affect keys without trailing spaces", () => {
    const input = '{"action":"add","job":{"name":"test"}}';
    const result = parseStreamingJson(input);
    expect(result).toEqual({ action: "add", job: { name: "test" } });
  });

  it("handles arrays with objects containing trailing-space keys", () => {
    const input = '[{"key ":"value"}]';
    const result = parseStreamingJson(input);
    expect(result).toEqual({});
    // Direct parseJsonWithRepair should handle arrays.
    const direct = parseJsonWithRepair(input);
    expect(direct).toEqual([{ key: "value" }]);
  });
});
