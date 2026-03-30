import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const selectMock = vi.hoisted(() => vi.fn());
const createSecretsConfigIOMock = vi.hoisted(() => vi.fn());
const readJsonObjectIfExistsMock = vi.hoisted(() => vi.fn());

const mockedModuleIds = [
	"@clack/prompts",
	"./config-io.js",
	"./storage-scan.js",
] as const;

vi.mock("@clack/prompts", () => ({
	confirm: vi.fn(),
	select: (...args: unknown[]) => selectMock(...args),
	text: vi.fn(),
}));

vi.mock("./config-io.js", () => ({
	createSecretsConfigIO: (...args: unknown[]) =>
		createSecretsConfigIOMock(...args),
}));

vi.mock("./storage-scan.js", () => ({
	readJsonObjectIfExists: (...args: unknown[]) =>
		readJsonObjectIfExistsMock(...args),
}));

const { runSecretsConfigureInteractive } = await import("./configure.js");

describe("runSecretsConfigureInteractive", () => {
	beforeEach(() => {
		selectMock.mockReset();
		createSecretsConfigIOMock.mockReset();
		readJsonObjectIfExistsMock.mockReset();
	});

	afterAll(() => {
		for (const id of mockedModuleIds) {
			vi.doUnmock(id);
		}
		vi.resetModules();
	});

	it("does not load auth-profiles when running providers-only", async () => {
		Object.defineProperty(process.stdin, "isTTY", {
			value: true,
			configurable: true,
		});

		selectMock.mockResolvedValue("continue");
		createSecretsConfigIOMock.mockReturnValue({
			readConfigFileSnapshotForWrite: async () => ({
				snapshot: {
					valid: true,
					config: {},
					resolved: {},
				},
			}),
		});
		readJsonObjectIfExistsMock.mockReturnValue({
			error: "boom",
			value: null,
		});

		await expect(
			runSecretsConfigureInteractive({ providersOnly: true }),
		).rejects.toThrow("No secrets changes were selected.");
		expect(readJsonObjectIfExistsMock).not.toHaveBeenCalled();
	});
});
