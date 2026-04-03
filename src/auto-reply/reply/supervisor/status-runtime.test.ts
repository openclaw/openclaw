import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLatestSupervisorDecisionRecord } from "./decision-record.js";
import { readSupervisorDecisionOutcomeRecords } from "./outcome-record.js";
import { emitSupervisorStatusForActiveRun } from "./status-runtime.js";

describe("emitSupervisorStatusForActiveRun", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function createSessionFile() {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-supervisor-status-"));
    cleanup.push(tmpDir);
    const sessionFile = path.join(tmpDir, "agents", "main", "sessions", "sess-1.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "", "utf-8");
    return sessionFile;
  }

  it("records scheduled status deliveries for active followups", async () => {
    const sessionFile = await createSessionFile();
    const sendStatus = vi.fn(async () => true);

    await emitSupervisorStatusForActiveRun({
      sessionFile,
      sessionKey: "agent:main:thread-1",
      sessionId: "sess-1",
      queueMode: "collect",
      source: "feishu",
      bodyText: "预算上限是 3000",
      isStreaming: true,
      laneSize: 2,
      sendStatus,
      earlyStatusActivation: {
        shouldEmit: true,
        reason: "latency_pattern_indicates_a_truthful_status_would_reduce_visible_silence",
        decision: {
          shouldEmit: true,
          reason: "same_task_supplement_should_acknowledge_new_material",
        },
        recommendation: {
          level: "prioritize",
          reason: "runtime_started_but_visible_feedback_arrives_late",
        },
      },
    });

    expect(sendStatus).toHaveBeenCalledWith({
      text: "我会把你刚补充的信息并入当前任务。",
    });
    await expect(readLatestSupervisorDecisionRecord(sessionFile)).resolves.toMatchObject({
      relation: "same_task_supplement",
      action: "append",
      metadata: {
        finalQueueMode: "collect",
        presentationSummary: {
          status: {
            planned: true,
            scheduled_for_runtime: true,
            templateId: "status.updating_current_task",
          },
        },
      },
    });
    await expect(readSupervisorDecisionOutcomeRecords(sessionFile)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ signal: "runtime_applied" }),
        expect.objectContaining({
          signal: "presentation_planned",
          payload: expect.objectContaining({
            earlyStatusPolicy: {
              activationReason:
                "latency_pattern_indicates_a_truthful_status_would_reduce_visible_silence",
              recommendationLevel: "prioritize",
              recommendationReason: "runtime_started_but_visible_feedback_arrives_late",
            },
          }),
        }),
        expect.objectContaining({
          signal: "status_scheduled",
          payload: expect.objectContaining({
            earlyStatusPolicy: {
              activationReason:
                "latency_pattern_indicates_a_truthful_status_would_reduce_visible_silence",
              recommendationLevel: "prioritize",
              recommendationReason: "runtime_started_but_visible_feedback_arrives_late",
            },
          }),
        }),
        expect.objectContaining({
          signal: "first_visible_emitted",
          payload: {
            kind: "status",
            dispatch_to_first_visible_ms: expect.any(Number),
          },
        }),
        expect.objectContaining({
          signal: "first_visible_scheduled",
          payload: { kind: "status" },
        }),
      ]),
    );
  });

  it("records skipped status when delivery declines the payload", async () => {
    const sessionFile = await createSessionFile();

    await emitSupervisorStatusForActiveRun({
      sessionFile,
      sessionKey: "agent:main:thread-1",
      sessionId: "sess-1",
      queueMode: "steer",
      source: "qq",
      bodyText: "按 B 方案改",
      isStreaming: true,
      laneSize: 1,
      sendStatus: async () => false,
      earlyStatusActivation: {
        shouldEmit: true,
        reason: "replacement_of_active_task_is_prioritized_even_without_latency_signal",
        decision: {
          shouldEmit: true,
          reason: "same_task_correction_should_acknowledge_direction_change",
        },
        recommendation: {
          level: "observe",
          reason: "latency_is_dominant_before_visible_feedback_is_semantically_decidable",
        },
      },
    });

    const outcomes = await readSupervisorDecisionOutcomeRecords(sessionFile);
    expect(outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          signal: "status_skipped",
          payload: {
            reason: "status_delivery_declined",
            earlyStatusPolicy: {
              activationReason:
                "replacement_of_active_task_is_prioritized_even_without_latency_signal",
              recommendationLevel: "observe",
              recommendationReason:
                "latency_is_dominant_before_visible_feedback_is_semantically_decidable",
            },
          },
        }),
      ]),
    );
    expect(outcomes).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ signal: "first_visible_scheduled" })]),
    );
  });

  it("treats delivery errors as best-effort skips instead of failing the run", async () => {
    const sessionFile = await createSessionFile();

    await expect(
      emitSupervisorStatusForActiveRun({
        sessionFile,
        sessionKey: "agent:main:thread-1",
        sessionId: "sess-1",
        queueMode: "interrupt",
        source: "telegram",
        bodyText: "先别做刚才那个，改查告警",
        isStreaming: true,
        laneSize: 0,
        sendStatus: async () => {
          throw new Error("transport down");
        },
      }),
    ).resolves.toBeUndefined();

    await expect(readSupervisorDecisionOutcomeRecords(sessionFile)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          signal: "status_skipped",
          payload: {
            reason: "status_delivery_error:transport down",
          },
        }),
      ]),
    );
  });
});
