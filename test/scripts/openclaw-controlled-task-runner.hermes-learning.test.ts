import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { autoHermesLearn } from "../../scripts/openclaw-controlled-task-runner.mjs";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-runner-learning-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("openclaw-controlled-task-runner Hermes learning contract", () => {
  it("writes auditable success and failure pattern records", async () => {
    const repoRoot = await createTempDir();
    const task = { id: "controlled_task_runner_check", label: "Controlled task runner check" };
    const report = {
      task: { durationMs: 123 },
      remaining_blockers: ["blocked-a", "blocked-b"],
    };

    await autoHermesLearn(repoRoot, task, 0, report);
    await autoHermesLearn(repoRoot, task, 1, report);

    const statePath = path.join(
      repoRoot,
      "reports",
      "hermes-agent",
      "state",
      "learning-state.json",
    );
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      success_patterns: Array<Record<string, unknown>>;
      failure_patterns: Array<Record<string, unknown>>;
    };
    const success = state.success_patterns[0];
    const failure = state.failure_patterns[0];

    expect(success).toMatchObject({
      decision_version: 1,
      source: "controlled-task-runner",
      adopted_by: "controlled-task-runner",
      status: "success",
    });
    expect(failure).toMatchObject({
      decision_version: 1,
      source: "controlled-task-runner",
      adopted_by: null,
      status: "failure",
    });
    expect(String(success?.decision_id)).toMatch(/^controlled-task-runner:/);
    expect(String(failure?.decision_id)).toMatch(/^controlled-task-runner:/);
    expect(success?.rollback_pointer).toMatchObject({
      kind: "controlled-task-runner-record",
      trace_id: success?.trace_id,
      task_id: task.id,
    });
    expect(failure?.rollback_pointer).toMatchObject({
      kind: "controlled-task-runner-record",
      trace_id: failure?.trace_id,
      task_id: task.id,
    });
  });
});
