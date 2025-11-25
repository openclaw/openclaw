import { describe, expect, it } from "vitest";

import { parseClaudeJson, parseClaudeJsonText } from "./claude.js";

describe("claude JSON parsing", () => {
	it("extracts text from single JSON object", () => {
		const out = parseClaudeJsonText('{"text":"hello"}');
		expect(out).toBe("hello");
	});

	it("extracts from newline-delimited JSON", () => {
		const out = parseClaudeJsonText('{"irrelevant":1}\n{"text":"there"}');
		expect(out).toBe("there");
	});

	it("returns undefined on invalid JSON", () => {
		expect(parseClaudeJsonText("not json")).toBeUndefined();
	});

	it("extracts text from Claude CLI result field and preserves metadata", () => {
		const sample = {
			type: "result",
			subtype: "success",
			result: "hello from result field",
			duration_ms: 1234,
			usage: { server_tool_use: { tool_a: 2 } },
		};
		const parsed = parseClaudeJson(JSON.stringify(sample));
		expect(parsed?.text).toBe("hello from result field");
		expect(parsed?.parsed).toMatchObject({ duration_ms: 1234 });
	});
});
