import { beforeEach, describe, expect, it } from "vitest";
import { getOperatorTask, submitOperatorTask } from "../operator-control/task-store.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  getMissionControlAcpxSessionsSnapshot,
  ingestMissionControlAcpxEvents,
  resetMissionControlAcpxStoreForTests,
} from "./mission-control-acpx.js";

describe("mission-control ACPX ingestion", () => {
  beforeEach(() => {
    resetMissionControlAcpxStoreForTests();
  });

  it("ingests JSON payloads and exposes active session metadata", () => {
    const result = ingestMissionControlAcpxEvents({
      rawBody: JSON.stringify({
        events: [
          {
            sessionId: "acpx-session-1",
            agent: "raekwon",
            repo: "/workspace/projects/openclaw",
            cwd: "/workspace/projects/openclaw/src",
            status: "running",
            timestamp: 1_700_000_000_000,
          },
        ],
      }),
      contentType: "application/json",
    });

    expect(result).toMatchObject({
      accepted: 1,
      rejected: 0,
      sessionsUpdated: 1,
      storage: "memory",
    });

    const snapshot = getMissionControlAcpxSessionsSnapshot();
    expect(snapshot.summary).toMatchObject({
      totalTracked: 1,
      active: 1,
      idle: 0,
      error: 0,
      closed: 0,
    });
    expect(snapshot.sessions).toEqual([
      {
        sessionId: "acpx-session-1",
        agent: "raekwon",
        scope: {
          repo: "/workspace/projects/openclaw",
          cwd: "/workspace/projects/openclaw/src",
        },
        lastActivity: 1_700_000_000_000,
        status: "active",
      },
    ]);
  });

  it("ingests NDJSON and keeps latest status per session", () => {
    const result = ingestMissionControlAcpxEvents({
      rawBody: [
        JSON.stringify({
          sessionId: "acpx-session-2",
          agentId: "inspectah",
          scope: {
            repo: "/workspace/projects/bloktix",
            cwd: "/workspace/projects/bloktix/bt-auth",
          },
          status: "idle",
          timestamp: 1_700_000_000_100,
        }),
        JSON.stringify({
          sessionId: "acpx-session-2",
          status: "error",
          timestamp: 1_700_000_000_200,
        }),
      ].join("\n"),
      contentType: "application/x-ndjson",
    });

    expect(result).toMatchObject({
      accepted: 2,
      rejected: 0,
      sessionsUpdated: 1,
    });

    const snapshot = getMissionControlAcpxSessionsSnapshot();
    expect(snapshot.summary).toMatchObject({
      totalTracked: 1,
      active: 0,
      idle: 0,
      error: 1,
      closed: 0,
    });
    expect(snapshot.sessions[0]).toMatchObject({
      sessionId: "acpx-session-2",
      agent: "inspectah",
      status: "error",
      lastActivity: 1_700_000_000_200,
      scope: {
        repo: "/workspace/projects/bloktix",
        cwd: "/workspace/projects/bloktix/bt-auth",
      },
    });
  });

  it("reports rejected events for invalid records", () => {
    const result = ingestMissionControlAcpxEvents({
      rawBody: ['{"agent":"missing-session"}', "not-json"].join("\n"),
      contentType: "application/x-ndjson",
    });

    expect(result.accepted).toBe(0);
    expect(result.rejected).toBe(2);
    expect(result.errors).toEqual([
      { index: 0, reason: "sessionId is required" },
      { index: 1, reason: "invalid NDJSON line" },
    ]);

    const snapshot = getMissionControlAcpxSessionsSnapshot();
    expect(snapshot.sessions).toEqual([]);
    expect(snapshot.summary.totalTracked).toBe(0);
  });

  it("correlates task metadata and advances operator task state from ACPX events", async () => {
    await withStateDirEnv("mission-control-acpx-task-correlation-", async () => {
      submitOperatorTask({
        task_id: "task-acpx-1",
        idempotency_key: "task-acpx-1",
        requester: { id: "tonya", kind: "operator" },
        target: { capability: "backend", alias: "raekwon" },
        objective: "Correlate ACPX session progress",
        tier: "STANDARD",
        acceptance_criteria: ["session progress visible"],
        timeout_s: 900,
      });

      const result = ingestMissionControlAcpxEvents({
        rawBody: JSON.stringify({
          events: [
            {
              sessionId: "acpx-session-task-1",
              agent: "raekwon",
              status: "running",
              taskId: "task-acpx-1",
              runId: "task-run-acpx",
              timestamp: 1_700_000_000_000,
            },
          ],
        }),
        contentType: "application/json",
      });

      expect(result.accepted).toBe(1);

      const task = getOperatorTask("task-acpx-1");
      expect(task?.receipt.state).toBe("started");
      expect(task?.receipt.owner).toBe("raekwon");

      const snapshot = getMissionControlAcpxSessionsSnapshot();
      expect(snapshot.sessions[0]).toMatchObject({
        sessionId: "acpx-session-task-1",
        agent: "raekwon",
        status: "active",
        taskId: "task-acpx-1",
        runId: "task-run-acpx",
      });
    });
  });
});
