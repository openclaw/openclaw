import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistantHandlers } from "./assistant.js";

let previousHome: string | undefined;
let tempHome: string;

async function call(method: keyof typeof assistantHandlers, params: unknown = {}) {
  const respond = vi.fn();
  await assistantHandlers[method]?.({
    params: params as Record<string, unknown>,
    respond,
  } as never);
  return respond.mock.calls[0];
}

function writeStatusFile(fileName: string, payload: unknown) {
  writeFileSync(
    join(tempHome, "status", fileName),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
}

beforeEach(() => {
  previousHome = process.env.OPENCLAW_WORKBENCH_HOME;
  tempHome = mkdtempSync(join(tmpdir(), "openclaw-assistant-test-"));
  mkdirSync(join(tempHome, "status"));
  process.env.OPENCLAW_WORKBENCH_HOME = tempHome;
  vi.clearAllMocks();
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.OPENCLAW_WORKBENCH_HOME;
  } else {
    process.env.OPENCLAW_WORKBENCH_HOME = previousHome;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

describe("assistant gateway methods", () => {
  it("reads only explicit safe task and decision artifacts", async () => {
    writeStatusFile("codex-task-index.json", {
      updated_at: "2026-05-08T10:00:00.000Z",
      tasks: [
        {
          task_id: "task_1",
          title: "Continue local work",
          workspace: "/tmp/project",
          source: "codex-app",
          status: "running",
          risk: "low",
          owner: "codex-app",
          allowed_actions: ["read_status", "continue_registered_local_task"],
          handoff: { state: "not_handed_off" },
          updated_at: "2026-05-08T10:00:00.000Z",
          raw_transcript_path: "/private/transcript.jsonl",
        },
        {
          task_id: "task_2",
          title: "Push remote",
          workspace: "/tmp/project",
          source: "codex-app",
          status: "needs_decision",
          risk: "hard-boundary",
          owner: "codex-app",
          allowed_actions: ["read_status"],
          handoff: { state: "not_handed_off" },
          updated_at: "2026-05-08T10:00:00.000Z",
        },
        {
          task_id: "task_3",
          title: "Needs decision cannot continue",
          workspace: "/tmp/project",
          source: "codex-app",
          status: "needs_decision",
          risk: "medium",
          owner: "codex-app",
          allowed_actions: ["continue_registered_local_task"],
          handoff: { state: "approved" },
          updated_at: "2026-05-08T10:00:00.000Z",
        },
      ],
    });
    writeStatusFile("pending-decisions.json", {
      decisions: [
        {
          id: "decision_1",
          title: "Remote write gate",
          raw_transcript_path: "/private/decision.jsonl",
        },
      ],
    });

    const [ok, payload] = await call("assistant.status");

    expect(ok).toBe(true);
    expect(payload).toMatchObject({
      taskIndexUpdatedAt: "2026-05-08T10:00:00.000Z",
      taskCount: 3,
      activeTaskCount: 3,
      pendingDecisionCount: 3,
      continueCandidateCount: 1,
      continueCandidates: [
        expect.objectContaining({
          taskId: "task_1",
          risk: "low",
          allowedActions: ["read_status", "continue_registered_local_task"],
        }),
      ],
      excludedSources: expect.arrayContaining(["Codex App sqlite", "raw transcripts"]),
      loadErrors: [],
    });
    expect(payload.tasks[0]).not.toHaveProperty("raw_transcript_path");
    expect(payload.decisions[0]).not.toHaveProperty("raw_transcript_path");
    expect(payload.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "safe-task:task_2", task_id: "task_2" }),
        expect.objectContaining({ id: "safe-task:task_3", task_id: "task_3" }),
      ]),
    );
    expect(payload.continueCandidates[0].record).not.toHaveProperty("raw_transcript_path");
  });

  it("returns pending decisions and continue candidates as separate read-only views", async () => {
    writeStatusFile("codex-task-index.json", {
      tasks: [
        {
          task_id: "task_1",
          title: "Approved handoff",
          workspace: "/tmp/project",
          source: "codex-app",
          status: "blocked",
          risk: "medium",
          owner: "codex-app",
          allowed_actions: ["read_status"],
          handoff: { state: "approved" },
          updated_at: "2026-05-08T10:00:00.000Z",
        },
      ],
    });
    writeStatusFile("pending-decisions.json", {
      decisions: [{ id: "decision_1", title: "Approval target" }],
    });

    const [, decisions] = await call("assistant.decisions.list");
    const [, candidates] = await call("assistant.continueCandidates");

    expect(decisions).toMatchObject({
      count: 1,
      decisions: [{ id: "decision_1" }],
    });
    expect(candidates).toMatchObject({
      count: 1,
      candidates: [{ taskId: "task_1", handoffState: "approved" }],
      policy: {
        hardBoundary: "needs_decision",
      },
    });
  });

  it("rejects unexpected params", async () => {
    const [ok, , error] = await call("assistant.status", { includeRawTranscripts: true });

    expect(ok).toBe(false);
    expect(error).toMatchObject({ code: "INVALID_REQUEST" });
  });
});
