import { describe, expect, it } from "vitest";
import { matchCapabilities } from "./capability-matcher.js";

describe("matchCapabilities", () => {
	it("returns true when agent has at least one matching capability (ANY-match)", () => {
		expect(matchCapabilities(["code", "testing"], ["code", "ui"])).toBe(true);
	});

	it("returns false when agent has no matching capabilities", () => {
		expect(matchCapabilities(["code"], ["testing", "ui"])).toBe(false);
	});

	it("returns true when taskCaps is empty (no restriction)", () => {
		expect(matchCapabilities(["code"], [])).toBe(true);
	});

	it("returns false when agentCaps is empty but taskCaps is non-empty", () => {
		expect(matchCapabilities([], ["code"])).toBe(false);
	});

	it("returns true when both are empty", () => {
		expect(matchCapabilities([], [])).toBe(true);
	});

	it("returns true when agent is superset of task capabilities", () => {
		expect(matchCapabilities(["code", "testing", "ui"], ["ui"])).toBe(true);
	});
});
