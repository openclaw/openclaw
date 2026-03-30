import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const TASK_ROOT = path.resolve(import.meta.dirname);
const SRC_ROOT = path.resolve(TASK_ROOT, "..");

const RAW_TASK_MUTATORS = [
	"createTaskRecord",
	"markTaskRunningByRunId",
	"markTaskTerminalByRunId",
	"markTaskTerminalById",
	"setTaskRunDeliveryStatusByRunId",
] as const;

const ALLOWED_CALLERS = new Set([
	"tasks/task-executor.ts",
	"tasks/task-registry.ts",
	"tasks/task-registry.maintenance.ts",
]);

async function listSourceFiles(root: string): Promise<string[]> {
	const entries = await fs.readdir(root, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const fullPath = path.join(root, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listSourceFiles(fullPath)));
			continue;
		}
		if (
			!entry.isFile() ||
			!entry.name.endsWith(".ts") ||
			entry.name.endsWith(".test.ts")
		) {
			continue;
		}
		files.push(fullPath);
	}
	return files;
}

describe("task executor boundary", () => {
	it("keeps raw task lifecycle mutators behind task internals", async () => {
		const offenders: string[] = [];
		for (const file of await listSourceFiles(SRC_ROOT)) {
			const relative = path.relative(SRC_ROOT, file).replaceAll(path.sep, "/");
			if (ALLOWED_CALLERS.has(relative)) {
				continue;
			}
			const source = await fs.readFile(file, "utf8");
			for (const symbol of RAW_TASK_MUTATORS) {
				if (source.includes(`${symbol}(`)) {
					offenders.push(`${relative}:${symbol}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});
