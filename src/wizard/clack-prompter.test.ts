import { describe, expect, it } from "vitest";
import { tokenizedOptionFilter } from "./clack-prompter.js";

describe("tokenizedOptionFilter", () => {
	it("matches tokens regardless of order", () => {
		const option = {
			value: "openai/gpt-5.4",
			label: "openai/gpt-5.4",
			hint: "ctx 400k",
		};

		expect(tokenizedOptionFilter("gpt-5.4 openai/", option)).toBe(true);
		expect(tokenizedOptionFilter("openai/ gpt-5.4", option)).toBe(true);
	});

	it("requires all tokens to match", () => {
		const option = {
			value: "openai/gpt-5.4",
			label: "openai/gpt-5.4",
		};

		expect(tokenizedOptionFilter("gpt-5.4 anthropic/", option)).toBe(false);
	});

	it("matches against label, hint, and value", () => {
		const option = {
			value: "openai/gpt-5.4",
			label: "GPT 5.4",
			hint: "provider openai",
		};

		expect(tokenizedOptionFilter("provider openai", option)).toBe(true);
		expect(tokenizedOptionFilter("openai gpt-5.4", option)).toBe(true);
	});
});
