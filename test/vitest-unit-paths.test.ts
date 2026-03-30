import { describe, expect, it } from "vitest";
import { isUnitConfigTestFile } from "../vitest.unit-paths.mjs";
import { bundledPluginFile } from "./helpers/bundled-plugin-paths.js";

describe("isUnitConfigTestFile", () => {
	it("accepts unit-config src, test, and whitelisted ui tests", () => {
		expect(isUnitConfigTestFile("src/infra/git-commit.test.ts")).toBe(true);
		expect(isUnitConfigTestFile("test/format-error.test.ts")).toBe(true);
		expect(isUnitConfigTestFile("ui/src/ui/views/channels.test.ts")).toBe(true);
		expect(isUnitConfigTestFile("ui/src/ui/views/chat.test.ts")).toBe(true);
	});

	it("rejects files excluded from the unit config", () => {
		expect(
			isUnitConfigTestFile(
				bundledPluginFile(
					"imessage",
					"src/monitor.shutdown.unhandled-rejection.test.ts",
				),
			),
		).toBe(false);
		expect(isUnitConfigTestFile("src/agents/pi-embedded-runner.test.ts")).toBe(
			false,
		);
		expect(isUnitConfigTestFile("src/commands/onboard.test.ts")).toBe(false);
		expect(isUnitConfigTestFile("ui/src/ui/views/other.test.ts")).toBe(false);
		expect(isUnitConfigTestFile("src/infra/git-commit.live.test.ts")).toBe(
			false,
		);
		expect(isUnitConfigTestFile("src/infra/git-commit.e2e.test.ts")).toBe(
			false,
		);
	});
});
