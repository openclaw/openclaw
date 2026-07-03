import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DURABLE_AGENT_TURN_OPERATION_KIND,
  DURABLE_SUBAGENT_RUN_OPERATION_KIND,
} from "./runtime-ids.js";
import { openDurableRuntimeSqliteStore } from "./sqlite-store.js";
import {
  recordDurableSubagentAnnounceDelivery,
  recordDurableSubagentProgress,
  recordDurableSubagentRegistered,
  recordDurableSubagentTerminal,
} from "./subagent.js";

describe("durable subagent bridge", () => {
  it("links children to the active requester run when same-session parents overlap", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-subagent-"));
    const dbPath = path.join(dir, "state", "openclaw.sqlite");
    const env = {
      ...process.env,
      OPENCLAW_DURABLE_RUNTIME: "1",
      OPENCLAW_STATE_DIR: dir,
    };
    const parentSessionKey = "agent:bo:discord:channel:bo-main";

    let olderParentId = "";
    let activeParentId = "";
    const setupStore = openDurableRuntimeSqliteStore({ path: dbPath });
    try {
      olderParentId = setupStore.createRun({
        operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
        status: "running",
        recoveryState: "running",
        idempotencyKey: "run_parent_old",
        sourceType: "agent_turn",
        sourceRef: parentSessionKey,
        metadata: { sessionKey: parentSessionKey },
        now: 100,
      }).runtimeRunId;
      activeParentId = setupStore.createRun({
        operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
        status: "running",
        recoveryState: "running",
        idempotencyKey: "run_parent_active",
        sourceType: "agent_turn",
        sourceRef: parentSessionKey,
        metadata: { sessionKey: parentSessionKey },
        now: 200,
      }).runtimeRunId;
    } finally {
      setupStore.close();
    }

    recordDurableSubagentRegistered({
      runId: "run_child",
      childSessionKey: "agent:bo:subagent:active-child",
      requesterSessionKey: parentSessionKey,
      requesterRunId: "run_parent_active",
      task: "Check active parent binding",
      label: "active parent",
      agentId: "bo",
      requesterAgentId: "bo",
      env,
    });

    const assertStore = openDurableRuntimeSqliteStore({ path: dbPath });
    try {
      const child = assertStore
        .listRuns({ limit: 20 })
        .find((run) => run.operationKind === DURABLE_SUBAGENT_RUN_OPERATION_KIND);
      expect(child).toBeDefined();
      expect(child?.parentRuntimeRunId).toBe(activeParentId);
      expect(child?.parentRuntimeRunId).not.toBe(olderParentId);
      expect(assertStore.listChildLinks(activeParentId)).toMatchObject([
        {
          childRuntimeRunId: child?.runtimeRunId,
          status: "running",
        },
      ]);
      expect(assertStore.listChildLinks(olderParentId)).toEqual([]);
    } finally {
      assertStore.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the newest same-session parent when requester run id is unavailable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-subagent-"));
    const dbPath = path.join(dir, "state", "openclaw.sqlite");
    const env = {
      ...process.env,
      OPENCLAW_DURABLE_RUNTIME: "1",
      OPENCLAW_STATE_DIR: dir,
    };
    const parentSessionKey = "agent:bo:discord:channel:bo-main";

    let newerParentId = "";
    const setupStore = openDurableRuntimeSqliteStore({ path: dbPath });
    try {
      setupStore.createRun({
        operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
        status: "running",
        recoveryState: "running",
        idempotencyKey: "run_parent_old",
        sourceType: "agent_turn",
        sourceRef: parentSessionKey,
        metadata: { sessionKey: parentSessionKey },
        now: 100,
      });
      newerParentId = setupStore.createRun({
        operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
        status: "running",
        recoveryState: "running",
        idempotencyKey: "run_parent_new",
        sourceType: "agent_turn",
        sourceRef: parentSessionKey,
        metadata: { sessionKey: parentSessionKey },
        now: 200,
      }).runtimeRunId;
    } finally {
      setupStore.close();
    }

    recordDurableSubagentRegistered({
      runId: "run_child",
      childSessionKey: "agent:bo:subagent:newest-child",
      requesterSessionKey: parentSessionKey,
      task: "Check newest parent binding",
      label: "newest parent",
      agentId: "bo",
      requesterAgentId: "bo",
      env,
    });

    const assertStore = openDurableRuntimeSqliteStore({ path: dbPath });
    try {
      const child = assertStore
        .listRuns({ limit: 20 })
        .find((run) => run.operationKind === DURABLE_SUBAGENT_RUN_OPERATION_KIND);
      expect(child).toBeDefined();
      expect(child?.parentRuntimeRunId).toBe(newerParentId);
    } finally {
      assertStore.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves external task bindings on child runs and parent links", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-subagent-"));
    const dbPath = path.join(dir, "state", "openclaw.sqlite");
    const env = {
      ...process.env,
      OPENCLAW_DURABLE_RUNTIME: "1",
      OPENCLAW_STATE_DIR: dir,
    };
    const parentSessionKey = "agent:bo:discord:channel:bo-main";
    const childSessionKey = "agent:bo:subagent:wu-default-card";

    const setupStore = openDurableRuntimeSqliteStore({ path: dbPath });
    try {
      setupStore.createRun({
        operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
        status: "running",
        recoveryState: "running",
        sourceType: "agent_turn",
        sourceRef: parentSessionKey,
        metadata: { sessionKey: parentSessionKey },
        now: 100,
      });
    } finally {
      setupStore.close();
    }

    recordDurableSubagentRegistered({
      runId: "run_child",
      childSessionKey,
      requesterSessionKey: parentSessionKey,
      taskId: "task_child",
      taskFlowId: "flow_child",
      task: "Summarize durable bridge",
      label: "durable bridge",
      agentId: "bo",
      requesterAgentId: "bo",
      env,
    });

    recordDurableSubagentTerminal({
      runId: "run_child",
      childSessionKey,
      status: "success",
      summary: "done",
      env,
    });

    const assertStore = openDurableRuntimeSqliteStore({ path: dbPath });
    try {
      const child = assertStore
        .listRuns({ limit: 20 })
        .find((run) => run.operationKind === DURABLE_SUBAGENT_RUN_OPERATION_KIND);
      expect(child).toMatchObject({
        status: "succeeded",
        metadata: {
          runId: "run_child",
          taskId: "task_child",
          taskFlowId: "flow_child",
          taskHash: expect.any(String),
          childSessionKey,
          agentId: "bo",
          requesterAgentId: "bo",
          summary: "done",
        },
      });
      expect(child).toBeDefined();
      const parentLink = assertStore.listParentLinks(child!.runtimeRunId)[0];
      expect(parentLink).toMatchObject({
        status: "succeeded",
        metadata: {
          runId: "run_child",
          taskId: "task_child",
          taskFlowId: "flow_child",
          taskHash: expect.any(String),
          childSessionKey,
          summary: "done",
        },
      });
      expect(child?.metadata?.task).toBeUndefined();
      expect(parentLink?.metadata?.task).toBeUndefined();
    } finally {
      assertStore.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records running child progress without closing parent fan-in", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-subagent-"));
    const dbPath = path.join(dir, "state", "openclaw.sqlite");
    const env = {
      ...process.env,
      OPENCLAW_DURABLE_RUNTIME: "1",
      OPENCLAW_STATE_DIR: dir,
    };
    const parentSessionKey = "agent:bo:discord:channel:bo-main";
    const childSessionKey = "agent:bo-worker:subagent:slow-child";

    let parentRuntimeRunId = "";
    const setupStore = openDurableRuntimeSqliteStore({ path: dbPath });
    try {
      parentRuntimeRunId = setupStore.createRun({
        operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
        status: "running",
        recoveryState: "running",
        idempotencyKey: "run_parent",
        sourceType: "agent_turn",
        sourceRef: parentSessionKey,
        metadata: { sessionKey: parentSessionKey },
        now: 100,
      }).runtimeRunId;
    } finally {
      setupStore.close();
    }

    recordDurableSubagentRegistered({
      runId: "run_child_slow",
      childSessionKey,
      requesterSessionKey: parentSessionKey,
      requesterRunId: "run_parent",
      task: "Run a long command",
      label: "slow branch",
      env,
    });
    recordDurableSubagentProgress({
      runId: "run_child_slow",
      childSessionKey,
      status: "running",
      reason: "wait_timeout",
      detail: "child still running after durable wait checkpoint",
      elapsedMs: 180_000,
      env,
    });

    const assertStore = openDurableRuntimeSqliteStore({ path: dbPath });
    try {
      const child = assertStore
        .listRuns({ limit: 20 })
        .find((run) => run.operationKind === DURABLE_SUBAGENT_RUN_OPERATION_KIND);
      expect(child).toMatchObject({
        status: "running",
        recoveryState: "running",
        metadata: {
          childSessionKey,
          lastProgress: {
            status: "running",
            reason: "wait_timeout",
            detail: "child still running after durable wait checkpoint",
            elapsedMs: 180_000,
          },
        },
      });
      expect(assertStore.listChildLinks(parentRuntimeRunId)).toMatchObject([
        {
          childRuntimeRunId: child?.runtimeRunId,
          status: "running",
          metadata: {
            lastProgress: {
              status: "running",
              reason: "wait_timeout",
              elapsedMs: 180_000,
            },
          },
        },
      ]);
      expect(assertStore.listSteps(parentRuntimeRunId)).toContainEqual(
        expect.objectContaining({
          stepId: "subagents",
          status: "waiting",
          recoveryState: "waiting_child",
        }),
      );
    } finally {
      assertStore.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes runtime ok terminal status to durable success", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-subagent-"));
    const dbPath = path.join(dir, "state", "openclaw.sqlite");
    const env = {
      ...process.env,
      OPENCLAW_DURABLE_RUNTIME: "1",
      OPENCLAW_STATE_DIR: dir,
    };
    const parentSessionKey = "agent:bo:discord:channel:bo-main";
    const childSessionKey = "agent:bo:subagent:ok-child";

    const setupStore = openDurableRuntimeSqliteStore({ path: dbPath });
    try {
      setupStore.createRun({
        operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
        status: "running",
        recoveryState: "running",
        idempotencyKey: "run_parent_ok",
        sourceType: "agent_turn",
        sourceRef: parentSessionKey,
        metadata: { sessionKey: parentSessionKey },
        now: 100,
      });
    } finally {
      setupStore.close();
    }

    recordDurableSubagentRegistered({
      runId: "run_child_ok",
      childSessionKey,
      requesterSessionKey: parentSessionKey,
      requesterRunId: "run_parent_ok",
      task: "Return ok",
      env,
    });
    recordDurableSubagentTerminal({
      runId: "run_child_ok",
      childSessionKey,
      status: "ok",
      summary: "done",
      env,
    });

    const assertStore = openDurableRuntimeSqliteStore({ path: dbPath });
    try {
      const child = assertStore
        .listRuns({ limit: 20 })
        .find((run) => run.operationKind === DURABLE_SUBAGENT_RUN_OPERATION_KIND);
      expect(child).toMatchObject({
        status: "succeeded",
        recoveryState: "terminal",
        metadata: {
          status: "ok",
          summary: "done",
        },
      });
      expect(child).toBeDefined();
      expect(assertStore.listSteps(child!.runtimeRunId)).toContainEqual(
        expect.objectContaining({
          stepId: "subagent_run",
          status: "succeeded",
          recoveryState: "terminal",
          metadata: expect.objectContaining({
            status: "ok",
            summary: "done",
          }),
        }),
      );

      const parentLink = assertStore.listParentLinks(child!.runtimeRunId)[0];
      expect(parentLink).toMatchObject({
        status: "succeeded",
        metadata: {
          status: "ok",
          summary: "done",
        },
      });

      const parent = assertStore
        .listRuns({ limit: 20 })
        .find((run) => run.operationKind === DURABLE_AGENT_TURN_OPERATION_KIND);
      expect(parent).toMatchObject({
        status: "queued",
        recoveryState: "runnable",
      });
      expect(assertStore.listSteps(parent!.runtimeRunId)).toContainEqual(
        expect.objectContaining({
          stepId: "subagents",
          status: "succeeded",
          recoveryState: "terminal",
          metadata: expect.objectContaining({
            total: 1,
            succeeded: 1,
            failed: 0,
            terminal: 1,
          }),
        }),
      );
    } finally {
      assertStore.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks a yielded parent terminal after direct continuation succeeds", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-subagent-"));
    const dbPath = path.join(dir, "state", "openclaw.sqlite");
    const env = {
      ...process.env,
      OPENCLAW_DURABLE_RUNTIME: "1",
      OPENCLAW_STATE_DIR: dir,
    };
    const parentSessionKey = "agent:bo:discord:channel:bo-main";
    const directIdempotencyKey = "announce:run_child_ok";
    const setupStore = openDurableRuntimeSqliteStore({ path: dbPath });
    try {
      const parent = setupStore.createRun({
        operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
        status: "running",
        recoveryState: "running",
        idempotencyKey: "run_parent",
        sourceType: "agent_turn",
        sourceRef: parentSessionKey,
        metadata: { sessionKey: parentSessionKey },
        now: 100,
      });
      setupStore.createStep({
        runtimeRunId: parent.runtimeRunId,
        stepId: "agent_invocation",
        stepType: "agent",
        status: "running",
        recoveryState: "running",
        idempotencyKey: "run_parent",
        metadata: { sessionKey: parentSessionKey },
        now: 100,
      });
    } finally {
      setupStore.close();
    }

    recordDurableSubagentRegistered({
      runId: "run_child_ok",
      childSessionKey: "agent:bo:subagent:ok-child",
      requesterSessionKey: parentSessionKey,
      requesterRunId: "run_parent",
      task: "Check direct continuation",
      env,
    });
    recordDurableSubagentTerminal({
      runId: "run_child_ok",
      childSessionKey: "agent:bo:subagent:ok-child",
      status: "ok",
      summary: "done",
      env,
    });

    const directStore = openDurableRuntimeSqliteStore({ path: dbPath });
    try {
      directStore.createRun({
        operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
        status: "succeeded",
        recoveryState: "terminal",
        idempotencyKey: directIdempotencyKey,
        sourceType: "agent_turn",
        sourceRef: parentSessionKey,
        completedAt: 200,
        metadata: { sessionKey: parentSessionKey },
        now: 200,
      });
    } finally {
      directStore.close();
    }

    recordDurableSubagentAnnounceDelivery({
      runId: "run_child_ok",
      childSessionKey: "agent:bo:subagent:ok-child",
      directIdempotencyKey,
      delivered: true,
      path: "direct",
      env,
    });

    const assertStore = openDurableRuntimeSqliteStore({ path: dbPath });
    try {
      const parent = assertStore
        .listRuns({ limit: 20 })
        .find(
          (run) =>
            run.operationKind === DURABLE_AGENT_TURN_OPERATION_KIND &&
            run.idempotencyKey === "run_parent",
        );
      expect(parent).toMatchObject({
        status: "succeeded",
        recoveryState: "terminal",
      });
      expect(parent?.completedAt).toBeDefined();
      expect(assertStore.listSteps(parent!.runtimeRunId)).toContainEqual(
        expect.objectContaining({
          stepId: "agent_invocation",
          status: "succeeded",
          recoveryState: "terminal",
        }),
      );
      expect(assertStore.getTimeline(parent!.runtimeRunId)).toContainEqual(
        expect.objectContaining({
          eventType: "agent.turn.continuation_succeeded",
          agentInvocationId: directIdempotencyKey,
        }),
      );
    } finally {
      assertStore.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records failed continuation delivery without marking parent terminal", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-subagent-"));
    const dbPath = path.join(dir, "state", "openclaw.sqlite");
    const env = {
      ...process.env,
      OPENCLAW_DURABLE_RUNTIME: "1",
      OPENCLAW_STATE_DIR: dir,
    };
    const parentSessionKey = "agent:bo:discord:channel:bo-main";
    const setupStore = openDurableRuntimeSqliteStore({ path: dbPath });
    try {
      const parent = setupStore.createRun({
        operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
        status: "running",
        recoveryState: "running",
        idempotencyKey: "run_parent",
        sourceType: "agent_turn",
        sourceRef: parentSessionKey,
        metadata: { sessionKey: parentSessionKey },
        now: 100,
      });
      setupStore.createStep({
        runtimeRunId: parent.runtimeRunId,
        stepId: "agent_invocation",
        stepType: "agent",
        status: "running",
        recoveryState: "running",
        idempotencyKey: "run_parent",
        metadata: { sessionKey: parentSessionKey },
        now: 100,
      });
    } finally {
      setupStore.close();
    }

    recordDurableSubagentRegistered({
      runId: "run_child_failed_delivery",
      childSessionKey: "agent:bo:subagent:failed-delivery-child",
      requesterSessionKey: parentSessionKey,
      requesterRunId: "run_parent",
      task: "Check failed delivery",
      env,
    });
    recordDurableSubagentTerminal({
      runId: "run_child_failed_delivery",
      childSessionKey: "agent:bo:subagent:failed-delivery-child",
      status: "ok",
      summary: "done",
      env,
    });
    recordDurableSubagentAnnounceDelivery({
      runId: "run_child_failed_delivery",
      childSessionKey: "agent:bo:subagent:failed-delivery-child",
      directIdempotencyKey: "announce:failed-delivery",
      delivered: false,
      path: "direct",
      error: "gateway unavailable",
      env,
    });

    const assertStore = openDurableRuntimeSqliteStore({ path: dbPath });
    try {
      const parent = assertStore
        .listRuns({ limit: 20 })
        .find(
          (run) =>
            run.operationKind === DURABLE_AGENT_TURN_OPERATION_KIND &&
            run.idempotencyKey === "run_parent",
        );
      expect(parent).toMatchObject({
        status: "queued",
        recoveryState: "runnable",
      });
      expect(parent?.completedAt).toBeUndefined();
      expect(parent?.metadata?.lastSubagentAnnounceDelivery).toMatchObject({
        delivered: false,
        path: "direct",
        error: "gateway unavailable",
      });
      expect(assertStore.getTimeline(parent!.runtimeRunId)).toContainEqual(
        expect.objectContaining({
          eventType: "subagent.child.announce_delivery_failed",
        }),
      );
    } finally {
      assertStore.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reopens parent fan-in when a later child starts after an earlier child completed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-durable-subagent-"));
    const dbPath = path.join(dir, "state", "openclaw.sqlite");
    const env = {
      ...process.env,
      OPENCLAW_DURABLE_RUNTIME: "1",
      OPENCLAW_STATE_DIR: dir,
    };
    const parentSessionKey = "agent:bo:discord:channel:bo-main";
    const setupStore = openDurableRuntimeSqliteStore({ path: dbPath });
    try {
      setupStore.createRun({
        operationKind: DURABLE_AGENT_TURN_OPERATION_KIND,
        status: "running",
        recoveryState: "running",
        idempotencyKey: "run_parent",
        sourceType: "agent_turn",
        sourceRef: parentSessionKey,
        metadata: { sessionKey: parentSessionKey },
        now: 100,
      });
    } finally {
      setupStore.close();
    }

    recordDurableSubagentRegistered({
      runId: "run_child_a",
      childSessionKey: "agent:bo:subagent:child-a",
      requesterSessionKey: parentSessionKey,
      requesterRunId: "run_parent",
      task: "First child",
      env,
    });
    recordDurableSubagentTerminal({
      runId: "run_child_a",
      childSessionKey: "agent:bo:subagent:child-a",
      status: "success",
      summary: "child a done",
      env,
    });
    recordDurableSubagentRegistered({
      runId: "run_child_b",
      childSessionKey: "agent:bo:subagent:child-b",
      requesterSessionKey: parentSessionKey,
      requesterRunId: "run_parent",
      task: "Second child",
      env,
    });

    const assertStore = openDurableRuntimeSqliteStore({ path: dbPath });
    try {
      const parent = assertStore
        .listRuns({ limit: 20 })
        .find((run) => run.operationKind === DURABLE_AGENT_TURN_OPERATION_KIND);
      expect(parent).toMatchObject({
        status: "waiting_child",
        recoveryState: "waiting_child",
      });
      expect(parent?.completedAt).toBeUndefined();
      const fanInStep = assertStore
        .listSteps(parent!.runtimeRunId)
        .find((step) => step.stepId === "subagents");
      expect(fanInStep).toMatchObject({
        stepId: "subagents",
        status: "waiting",
        recoveryState: "waiting_child",
      });
      expect(fanInStep?.completedAt).toBeUndefined();
      expect(assertStore.listChildLinks(parent!.runtimeRunId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "succeeded" }),
          expect.objectContaining({ status: "running" }),
        ]),
      );
    } finally {
      assertStore.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
