import { describe, expect, it } from "vitest";
import { BtwInlineMessage } from "./btw-inline-message.js";

describe("btw inline message", () => {
	it("renders the BTW question, answer, and dismiss hint inline", () => {
		const message = new BtwInlineMessage({
			question: "what is 17 * 19?",
			text: "323",
		});

		const rendered = message.render(80).join("\n");
		expect(rendered).toContain("BTW: what is 17 * 19?");
		expect(rendered).toContain("323");
		expect(rendered).toContain("Press Enter or Esc to dismiss");
	});
});
