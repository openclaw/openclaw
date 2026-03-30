import { describe, expect, it } from "vitest";
import {
	collectExtensionPluginSdkBoundaryInventory,
	main,
} from "../scripts/check-extension-plugin-sdk-boundary.mjs";
import { createCapturedIo } from "./helpers/captured-io.js";

const srcOutsideInventoryPromise = collectExtensionPluginSdkBoundaryInventory(
	"src-outside-plugin-sdk",
);
const pluginSdkInternalInventoryPromise =
	collectExtensionPluginSdkBoundaryInventory("plugin-sdk-internal");
const relativeOutsidePackageInventoryPromise =
	collectExtensionPluginSdkBoundaryInventory("relative-outside-package");
const srcOutsideJsonOutputPromise = getJsonOutput("src-outside-plugin-sdk");
const pluginSdkInternalJsonOutputPromise = getJsonOutput("plugin-sdk-internal");
const relativeOutsidePackageJsonOutputPromise = getJsonOutput(
	"relative-outside-package",
);

async function getJsonOutput(
	mode: Parameters<typeof collectExtensionPluginSdkBoundaryInventory>[0],
) {
	const captured = createCapturedIo();
	const exitCode = await main([`--mode=${mode}`, "--json"], captured.io);
	return {
		exitCode,
		stderr: captured.readStderr(),
		json: JSON.parse(captured.readStdout()),
	};
}

describe("extension src outside plugin-sdk boundary inventory", () => {
	it("stays empty and sorted", async () => {
		const inventory = await srcOutsideInventoryPromise;
		const jsonResult = await srcOutsideJsonOutputPromise;

		expect(inventory).toEqual([]);
		expect(
			[...inventory].toSorted(
				(left, right) =>
					left.file.localeCompare(right.file) ||
					left.line - right.line ||
					left.kind.localeCompare(right.kind) ||
					left.specifier.localeCompare(right.specifier) ||
					left.resolvedPath.localeCompare(right.resolvedPath) ||
					left.reason.localeCompare(right.reason),
			),
		).toEqual(inventory);
		expect(jsonResult.exitCode).toBe(0);
		expect(jsonResult.stderr).toBe("");
		expect(jsonResult.json).toEqual([]);
	});
});

describe("extension plugin-sdk-internal boundary inventory", () => {
	it("stays empty", async () => {
		const inventory = await pluginSdkInternalInventoryPromise;
		const jsonResult = await pluginSdkInternalJsonOutputPromise;

		expect(inventory).toEqual([]);
		expect(jsonResult.exitCode).toBe(0);
		expect(jsonResult.stderr).toBe("");
		expect(jsonResult.json).toEqual([]);
	});
});

describe("extension relative-outside-package boundary inventory", () => {
	it("stays empty", async () => {
		const inventory = await relativeOutsidePackageInventoryPromise;
		const jsonResult = await relativeOutsidePackageJsonOutputPromise;

		expect(inventory).toEqual([]);
		expect(jsonResult.exitCode).toBe(0);
		expect(jsonResult.stderr).toBe("");
		expect(jsonResult.json).toEqual([]);
	});
});
