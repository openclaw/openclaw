import { afterEach, describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
	createFlowRecord,
	deleteFlowRecordById,
	getFlowById,
	listFlowRecords,
	resetFlowRegistryForTests,
	updateFlowRecordById,
} from "./flow-registry.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

describe("flow-registry", () => {
	afterEach(() => {
		if (ORIGINAL_STATE_DIR === undefined) {
			delete process.env.OPENCLAW_STATE_DIR;
		} else {
			process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
		}
		resetFlowRegistryForTests();
	});

	it("creates, updates, lists, and deletes flow records", async () => {
		await withTempDir({ prefix: "openclaw-flow-registry-" }, async (root) => {
			process.env.OPENCLAW_STATE_DIR = root;
			resetFlowRegistryForTests();

			const created = createFlowRecord({
				ownerSessionKey: "agent:main:main",
				goal: "Investigate flaky test",
				status: "running",
				currentStep: "spawn_task",
			});

			expect(getFlowById(created.flowId)).toMatchObject({
				flowId: created.flowId,
				status: "running",
				currentStep: "spawn_task",
			});

			const updated = updateFlowRecordById(created.flowId, {
				status: "waiting",
				currentStep: "ask_user",
			});
			expect(updated).toMatchObject({
				flowId: created.flowId,
				status: "waiting",
				currentStep: "ask_user",
			});

			expect(listFlowRecords()).toEqual([
				expect.objectContaining({
					flowId: created.flowId,
					goal: "Investigate flaky test",
					status: "waiting",
				}),
			]);

			expect(deleteFlowRecordById(created.flowId)).toBe(true);
			expect(getFlowById(created.flowId)).toBeUndefined();
			expect(listFlowRecords()).toEqual([]);
		});
	});

	it("applies minimal defaults for new flow records", async () => {
		await withTempDir({ prefix: "openclaw-flow-registry-" }, async (root) => {
			process.env.OPENCLAW_STATE_DIR = root;
			resetFlowRegistryForTests();

			const created = createFlowRecord({
				ownerSessionKey: "agent:main:main",
				goal: "Background job",
			});

			expect(created).toMatchObject({
				flowId: expect.any(String),
				ownerSessionKey: "agent:main:main",
				goal: "Background job",
				status: "queued",
				notifyPolicy: "done_only",
			});
			expect(created.currentStep).toBeUndefined();
			expect(created.endedAt).toBeUndefined();
		});
	});

	it("preserves endedAt when later updates change other flow fields", async () => {
		await withTempDir({ prefix: "openclaw-flow-registry-" }, async (root) => {
			process.env.OPENCLAW_STATE_DIR = root;
			resetFlowRegistryForTests();

			const created = createFlowRecord({
				ownerSessionKey: "agent:main:main",
				goal: "Finish a task",
				status: "succeeded",
				endedAt: 456,
			});

			const updated = updateFlowRecordById(created.flowId, {
				currentStep: "finish",
			});

			expect(updated).toMatchObject({
				flowId: created.flowId,
				currentStep: "finish",
				endedAt: 456,
			});
			expect(getFlowById(created.flowId)).toMatchObject({
				flowId: created.flowId,
				endedAt: 456,
			});
		});
	});
});
