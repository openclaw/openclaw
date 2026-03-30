import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildVitestProfileCommand,
	parseArgs,
	resolveVitestProfileDir,
} from "../../scripts/run-vitest-profile.mjs";

describe("scripts/run-vitest-profile", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		}
	});

	it("defaults profile output outside the repo", () => {
		const outputDir = resolveVitestProfileDir({ mode: "main", outputDir: "" });
		tempDirs.push(outputDir);

		expect(outputDir.startsWith(os.tmpdir())).toBe(true);
		expect(outputDir.startsWith(process.cwd())).toBe(false);
	});

	it("keeps explicit output directories", () => {
		expect(
			resolveVitestProfileDir({
				mode: "runner",
				outputDir: ".artifacts/custom-profile",
			}),
		).toBe(path.resolve(".artifacts/custom-profile"));
	});

	it("builds main-thread cpu profiling args", () => {
		expect(
			buildVitestProfileCommand({
				mode: "main",
				outputDir: "/tmp/profile-main",
			}),
		).toEqual({
			command: process.execPath,
			args: [
				"--cpu-prof",
				"--cpu-prof-dir=/tmp/profile-main",
				"./node_modules/vitest/vitest.mjs",
				"run",
				"--config",
				"vitest.unit.config.ts",
				"--no-file-parallelism",
			],
		});
	});

	it("builds runner cpu and heap profiling args", () => {
		expect(
			buildVitestProfileCommand({
				mode: "runner",
				outputDir: "/tmp/profile-runner",
			}),
		).toEqual({
			command: "pnpm",
			args: [
				"vitest",
				"run",
				"--config",
				"vitest.unit.config.ts",
				"--no-file-parallelism",
				"--execArgv=--cpu-prof",
				"--execArgv=--cpu-prof-dir=/tmp/profile-runner",
				"--execArgv=--heap-prof",
				"--execArgv=--heap-prof-dir=/tmp/profile-runner",
			],
		});
	});

	it("parses mode and explicit output dir", () => {
		expect(parseArgs(["runner", "--output-dir", "/tmp/out"])).toEqual({
			mode: "runner",
			outputDir: "/tmp/out",
		});
	});
});
