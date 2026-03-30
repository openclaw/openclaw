import { describe, expect, it } from "vitest";
import { resolveWindowsCommandShim } from "./windows-command.js";

describe("resolveWindowsCommandShim", () => {
	it("leaves commands unchanged outside Windows", () => {
		expect(
			resolveWindowsCommandShim({
				command: "pnpm",
				cmdCommands: ["pnpm"],
				platform: "linux",
			}),
		).toBe("pnpm");
	});

	it("appends .cmd for configured Windows shims", () => {
		expect(
			resolveWindowsCommandShim({
				command: "pnpm",
				cmdCommands: ["pnpm", "yarn"],
				platform: "win32",
			}),
		).toBe("pnpm.cmd");
	});

	it("keeps explicit extensions on Windows", () => {
		expect(
			resolveWindowsCommandShim({
				command: "npm.cmd",
				cmdCommands: ["npm", "npx"],
				platform: "win32",
			}),
		).toBe("npm.cmd");
	});
});
