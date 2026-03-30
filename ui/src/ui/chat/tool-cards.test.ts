/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import { extractToolCards, renderToolCardSidebar } from "./tool-cards.ts";

describe("tool cards", () => {
	it("renders anthropic tool_use input details in tool cards", () => {
		const cards = extractToolCards({
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: "toolu_123",
					name: "Bash",
					input: { command: 'time claude -p "say ok"' },
				},
			],
		});

		expect(cards).toHaveLength(1);
		expect(cards[0]).toMatchObject({
			kind: "call",
			name: "Bash",
			args: { command: 'time claude -p "say ok"' },
		});

		const container = document.createElement("div");
		render(renderToolCardSidebar(cards[0]), container);

		expect(container.textContent).toContain('time claude -p "say ok"');
		expect(container.textContent).toContain("Bash");
	});
});
