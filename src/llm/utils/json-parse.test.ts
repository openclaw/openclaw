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
});

describe("parseStreamingJson", () => {
  it("returns empty object for empty or whitespace input", () => {
    expect(parseStreamingJson("")).toEqual({});
    expect(parseStreamingJson("   ")).toEqual({});
    expect(parseStreamingJson(undefined)).toEqual({});
  });

  it("parses valid complete JSON", () => {
    const input = '{"action":"add","job":{"name":"test"}}';
    expect(parseStreamingJson(input)).toEqual({
      action: "add",
      job: { name: "test" },
    });
  });

  it("parses incomplete streaming JSON fragments via partial-json fallback", () => {
    const input = '{"action":"add","job":{"na';
    const result = parseStreamingJson(input);
    expect(result).toHaveProperty("action", "add");
    expect(result).toHaveProperty("job");
  });

  it("parses JSON with adjacent string keys correctly (regression for #88439)", () => {
    // This is the exact pattern from issue #88439: adjacent top-level keys
    // like "name" + "payload" must not be concatenated into "namePayload".
    const input = JSON.stringify({
      action: "add",
      job: {
        delivery: { mode: "none" },
        enabled: true,
        name: "evidence-test",
        payload: { kind: "agentTurn", message: "Evidence test.", timeoutSeconds: 10 },
        schedule: { everyMs: 999999, kind: "every" },
        sessionTarget: "isolated",
      },
    });
    const result = parseStreamingJson(input);
    const job = result.job as Record<string, unknown>;
    expect(job).toBeDefined();
    expect(job.name).toBe("evidence-test");
    expect(job.payload).toEqual({
      kind: "agentTurn",
      message: "Evidence test.",
      timeoutSeconds: 10,
    });
    expect(job.schedule).toEqual({ everyMs: 999999, kind: "every" });
    expect(job.sessionTarget).toBe("isolated");
    // Must NOT have concatenated keys.
    expect(job).not.toHaveProperty("namePayload");
    expect(job).not.toHaveProperty("scheduleKind");
    expect(job).not.toHaveProperty("sessionTargetName");
  });

  it("parses JSON with control characters via repairJson fallback", () => {
    // A newline inside a string value should be escaped by repairJson
    const input = '{"text":"line1\nline2"}';
    const result = parseStreamingJson(input);
    expect(result).toHaveProperty("text");
    expect(result.text).toContain("line1");
    expect(result.text).toContain("line2");
  });

  it("handles JSON5-style trailing commas via JSON5 fallback", () => {
    // JSON5 allows trailing commas — JSON.parse rejects them.
    // parseStreamingJson should succeed via the JSON5 fallback.
    const input = '{"a":1,"b":2,}';
    const result = parseStreamingJson(input);
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it("handles JSON5-style single-quoted strings via JSON5 fallback", () => {
    // JSON5 allows single-quoted strings — JSON.parse rejects them.
    const input = "{'name':'test','value':42}";
    const result = parseStreamingJson(input);
    expect(result).toEqual({ name: "test", value: 42 });
  });

  it("handles JSON5-style comments via JSON5 fallback", () => {
    const input = `{
      // This is a comment
      "name": "test",
      /* block comment */
      "value": 42
    }`;
    const result = parseStreamingJson(input);
    expect(result).toEqual({ name: "test", value: 42 });
  });

  it("returns empty object for completely invalid input", () => {
    const input = "not json at all {{{";
    const result = parseStreamingJson(input);
    expect(result).toEqual({});
  });
});

describe("parseJsonWithRepair", () => {
  it("parses valid JSON", () => {
    expect(parseJsonWithRepair('{"a":1}')).toEqual({ a: 1 });
  });

  it("repairs control characters in strings", () => {
    const input = '{"text":"hello\nworld"}';
    const result = parseJsonWithRepair(input) as { text: string };
    expect(result.text).toBe("hello\nworld");
  });

  it("throws for structurally invalid JSON that repair cannot fix", () => {
    expect(() => parseJsonWithRepair("{{{{")).toThrow();
  });
});

describe("repairJson", () => {
  it("escapes raw newlines inside strings", () => {
    const input = '{"a":"b\nc"}';
    const result = repairJson(input);
    expect(result).toContain("\\n");
  });

  it("does not modify JSON structure outside strings", () => {
    const input = '{"a":1,"b":2}';
    const result = repairJson(input);
    // The structure should be identical
    expect(JSON.parse(result)).toEqual({ a: 1, b: 2 });
  });

  it("preserves whitespace between JSON tokens", () => {
    const input = '{\n  "a": 1,\n  "b": 2\n}';
    const result = repairJson(input);
    expect(result).toBe(input); // No changes needed
    expect(JSON.parse(result)).toEqual({ a: 1, b: 2 });
  });
});
