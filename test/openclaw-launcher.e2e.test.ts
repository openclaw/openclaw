import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

async function makeLauncherFixture(fixtureRoots: string[]): Promise<string> {
	const fixtureRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), "openclaw-launcher-"),
	);
	fixtureRoots.push(fixtureRoot);
	await fs.copyFile(
		path.resolve(process.cwd(), "openclaw.mjs"),
		path.join(fixtureRoot, "openclaw.mjs"),
	);
	await fs.mkdir(path.join(fixtureRoot, "dist"), { recursive: true });
	return fixtureRoot;
}

async function addSourceTreeMarker(fixtureRoot: string): Promise<void> {
	await fs.mkdir(path.join(fixtureRoot, "src"), { recursive: true });
	await fs.writeFile(
		path.join(fixtureRoot, "src", "entry.ts"),
		"export {};\n",
		"utf8",
	);
}

describe("openclaw launcher", () => {
	const fixtureRoots: string[] = [];

	afterEach(async () => {
		await Promise.all(
			fixtureRoots.splice(0).map(async (fixtureRoot) => {
				await fs.rm(fixtureRoot, { recursive: true, force: true });
			}),
		);
	});

	it("surfaces transitive entry import failures instead of masking them as missing dist", async () => {
		const fixtureRoot = await makeLauncherFixture(fixtureRoots);
		await fs.writeFile(
			path.join(fixtureRoot, "dist", "entry.js"),
			'import "missing-openclaw-launcher-dep";\nexport {};\n',
			"utf8",
		);

		const result = spawnSync(
			process.execPath,
			[path.join(fixtureRoot, "openclaw.mjs"), "--help"],
			{
				cwd: fixtureRoot,
				encoding: "utf8",
			},
		);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("missing-openclaw-launcher-dep");
		expect(result.stderr).not.toContain("missing dist/entry.(m)js");
	});

	it("keeps the friendly launcher error for a truly missing entry build output", async () => {
		const fixtureRoot = await makeLauncherFixture(fixtureRoots);

		const result = spawnSync(
			process.execPath,
			[path.join(fixtureRoot, "openclaw.mjs"), "--help"],
			{
				cwd: fixtureRoot,
				encoding: "utf8",
			},
		);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("missing dist/entry.(m)js");
	});

	it("explains how to recover from an unbuilt source install", async () => {
		const fixtureRoot = await makeLauncherFixture(fixtureRoots);
		await addSourceTreeMarker(fixtureRoot);

		const result = spawnSync(
			process.execPath,
			[path.join(fixtureRoot, "openclaw.mjs"), "--help"],
			{
				cwd: fixtureRoot,
				encoding: "utf8",
			},
		);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("missing dist/entry.(m)js");
		expect(result.stderr).toContain(
			"unbuilt source tree or GitHub source archive",
		);
		expect(result.stderr).toContain("pnpm install && pnpm build");
		expect(result.stderr).toContain("github:openclaw/openclaw#<ref>");
	});
});
