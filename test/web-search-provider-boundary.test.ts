import { describe, expect, it } from "vitest";
import {
	collectWebSearchProviderBoundaryInventory,
	main,
} from "../scripts/check-web-search-provider-boundaries.mjs";
import { BUNDLED_PLUGIN_PATH_PREFIX } from "./helpers/bundled-plugin-paths.js";
import { createCapturedIo } from "./helpers/captured-io.js";

const inventoryPromise = collectWebSearchProviderBoundaryInventory();
const jsonOutputPromise = getJsonOutput();

async function getJsonOutput() {
	const captured = createCapturedIo();
	const exitCode = await main(["--json"], captured.io);
	return {
		exitCode,
		stderr: captured.readStderr(),
		json: JSON.parse(captured.readStdout()),
	};
}

describe("web search provider boundary inventory", () => {
	it("stays empty, core-only, and sorted", async () => {
		const inventory = await inventoryPromise;
		const jsonOutput = await jsonOutputPromise;

		expect(inventory).toEqual([]);
		expect(
			inventory.some((entry) =>
				entry.file.startsWith(BUNDLED_PLUGIN_PATH_PREFIX),
			),
		).toBe(false);
		expect(
			[...inventory].toSorted(
				(left, right) =>
					left.provider.localeCompare(right.provider) ||
					left.file.localeCompare(right.file) ||
					left.line - right.line ||
					left.reason.localeCompare(right.reason),
			),
		).toEqual(inventory);
		expect(jsonOutput.exitCode).toBe(0);
		expect(jsonOutput.stderr).toBe("");
		expect(jsonOutput.json).toEqual([]);
	});
});
