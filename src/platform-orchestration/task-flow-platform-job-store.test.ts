import { afterEach, describe, expect, it } from "vitest";
import { reloadTaskFlowRegistryFromStore } from "../tasks/task-flow-runtime-internal.js";
import { resetTaskFlowRegistryForTests } from "../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { PlatformJobFlowState } from "./platform-job-ports.js";
import { TaskFlowPlatformJobStore } from "./task-flow-platform-job-store.js";

const timestamp = "2026-07-18T12:00:00.000Z";

function state(status: "queued" | "executing", aggregateVersion: number): PlatformJobFlowState {
  return {
    stateVersion: 1,
    correlationId: "msg_018f0000-0000-7000-8000-000000000001",
    project: {
      projectId: "prj_018f0000-0000-7000-8000-000000000002",
      gitRepositoryId: "git_018f0000-0000-7000-8000-000000000003",
      baseCommitSha: "1".repeat(40),
      targetBranch: "main",
    },
    request: {
      schema_version: "1.0.0",
      project_id: "prj_018f0000-0000-7000-8000-000000000002",
      task: "Persist the transition",
      priority: "normal",
    },
    skillIds: ["skl_018f0000-0000-7000-8000-000000000006"],
    job: {
      schema_version: "1.0.0",
      job_id: "job_018f0000-0000-7000-8000-000000000004",
      project_id: "prj_018f0000-0000-7000-8000-000000000002",
      aggregate_version: aggregateVersion,
      status,
      task: "Persist the transition",
      priority: "normal",
      ...(status === "executing"
        ? { current_execution_id: "exe_018f0000-0000-7000-8000-000000000005" }
        : {}),
      created_at: timestamp,
      updated_at: timestamp,
    },
  };
}

afterEach(() => {
  resetTaskFlowRegistryForTests();
});

describe("TaskFlowPlatformJobStore", () => {
  it("persists state_json and rejects a stale revision", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-platform-job-" },
      async () => {
        resetTaskFlowRegistryForTests();
        try {
          const store = new TaskFlowPlatformJobStore();
          const created = store.create(state("queued", 1));
          const updated = store.save(created.flowId, created.revision, state("executing", 2));

          expect(() => store.save(created.flowId, created.revision, state("executing", 2))).toThrow(
            "revision_conflict",
          );

          reloadTaskFlowRegistryFromStore();
          expect(store.get(created.flowId)).toEqual({
            flowId: created.flowId,
            revision: updated.revision,
            state: state("executing", 2),
          });
        } finally {
          resetTaskFlowRegistryForTests();
        }
      },
    );
  });
});
