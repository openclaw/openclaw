import { describe, expect, it } from "vitest";
import { extractFirstTextBlock } from "./chat-message-content.js";

describe("shared/chat-message-content", () => {
	it("extracts the first text block from array content", () => {
		expect(
			extractFirstTextBlock({
				content: [{ text: "hello" }, { text: "world" }],
			}),
		).toBe("hello");
	});

	it("returns plain string content", () => {
		expect(
			extractFirstTextBlock({
				content: "hello from string content",
			}),
		).toBe("hello from string content");
	});

	it("preserves empty-string text in the first block", () => {
		expect(
			extractFirstTextBlock({
				content: [{ text: "" }, { text: "later" }],
			}),
		).toBe("");
	});

	it("only considers the first content block even if later blocks have text", () => {
		expect(
			extractFirstTextBlock({
				content: [null, { text: "later" }],
			}),
		).toBeUndefined();
		expect(
			extractFirstTextBlock({
				content: [{ type: "image" }, { text: "later" }],
			}),
		).toBeUndefined();
	});

	it("returns undefined for missing, empty, or non-text content", () => {
		expect(extractFirstTextBlock(null)).toBeUndefined();
		expect(extractFirstTextBlock({ content: [] })).toBeUndefined();
		expect(
			extractFirstTextBlock({ content: [{ type: "image" }] }),
		).toBeUndefined();
		expect(extractFirstTextBlock({ content: ["hello"] })).toBeUndefined();
		expect(
			extractFirstTextBlock({ content: [{ text: 1 }, { text: "later" }] }),
		).toBeUndefined();
	});
});
