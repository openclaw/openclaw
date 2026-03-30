import { describe, expect, it } from "vitest";
import { matchesHotspotSummaryLane } from "../../scripts/test-update-memory-hotspots-utils.mjs";

describe("test-update-memory-hotspots lane matching", () => {
	it("matches the exact target lane", () => {
		expect(matchesHotspotSummaryLane("unit-fast", "unit-fast")).toBe(true);
	});

	it("matches configured lane prefixes", () => {
		expect(
			matchesHotspotSummaryLane("unit-chat-memory-isolated", "unit-fast", [
				"unit-",
			]),
		).toBe(true);
	});

	it("rejects unrelated lanes", () => {
		expect(
			matchesHotspotSummaryLane("extensions", "unit-fast", ["unit-"]),
		).toBe(false);
	});
});
