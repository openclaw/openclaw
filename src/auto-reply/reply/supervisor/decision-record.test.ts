import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendSupervisorDecisionRecord,
  buildSupervisorDecisionRecord,
  readLatestSupervisorDecisionRecord,
  resolveSupervisorDecisionRecordPath,
} from "./decision-record.js";

describe("supervisor decision records", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("resolves a per-session record path parallel to sessions", () => {
    const sessionFile = "/tmp/openclaw/agents/main/sessions/sess-1.jsonl";
    expect(resolveSupervisorDecisionRecordPath(sessionFile)).toBe(
      "/tmp/openclaw/agents/main/supervisor-decisions/sess-1.jsonl",
    );
  });

  it("appends jsonl records", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-supervisor-"));
    cleanup.push(tmpDir);
    const sessionFile = path.join(tmpDir, "agents", "main", "sessions", "sess-1.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "", "utf-8");

    const record = buildSupervisorDecisionRecord({
      sessionKey: "agent:main:thread-1",
      sessionId: "sess-1",
      event: {
        type: "user_message",
        category: "user",
        source: "slack",
        timestamp: 1,
        payload: { text: "hello" },
        urgency: "normal",
        scope: "foreground",
        relatedSessionId: "sess-1",
      },
      taskStateSnapshot: {
        sessionKey: "agent:main:thread-1",
        sessionId: "sess-1",
        phase: "idle",
        interruptPreference: "avoid",
        interruptibility: "interruptible",
        isActive: false,
        isStreaming: false,
        laneSize: 0,
      },
      relation: "same_task_supplement",
      action: "append",
      classifier: { kind: "legacy_queue_translation" },
      rationale: { short: "test" },
      retrieval: { hitCount: 0 },
      outcome: { status: "pending" },
    });

    await appendSupervisorDecisionRecord({ sessionFile, record });

    const recordPath = resolveSupervisorDecisionRecordPath(sessionFile);
    const content = await fs.readFile(recordPath, "utf-8");
    const parsed = JSON.parse(content.trim()) as { action: string; sessionId: string };
    expect(parsed).toMatchObject({ action: "append", sessionId: "sess-1" });
  });

  it("reads the latest decision record for a session", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-supervisor-latest-"));
    cleanup.push(tmpDir);
    const sessionFile = path.join(tmpDir, "agents", "main", "sessions", "sess-1.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "", "utf-8");

    const first = buildSupervisorDecisionRecord({
      sessionKey: "agent:main:thread-1",
      sessionId: "sess-1",
      event: {
        type: "user_message",
        category: "user",
        source: "slack",
        timestamp: 1,
        payload: { text: "hello" },
        urgency: "normal",
        scope: "foreground",
      },
      taskStateSnapshot: {
        sessionKey: "agent:main:thread-1",
        sessionId: "sess-1",
        phase: "idle",
        interruptPreference: "avoid",
        interruptibility: "interruptible",
        isActive: false,
        isStreaming: false,
        laneSize: 0,
      },
      relation: "same_task_supplement",
      action: "append",
      classifier: { kind: "legacy_queue_translation" },
      rationale: { short: "first" },
    });
    const second = buildSupervisorDecisionRecord({
      ...first,
      rationale: { short: "second" },
      action: "steer",
      relation: "same_task_correction",
    });

    await appendSupervisorDecisionRecord({ sessionFile, record: first });
    await appendSupervisorDecisionRecord({ sessionFile, record: second });

    await expect(readLatestSupervisorDecisionRecord(sessionFile)).resolves.toMatchObject({
      action: "steer",
      relation: "same_task_correction",
    });
  });

  it("persists presentation plan drafts as planner metadata rather than emitted messages", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-supervisor-metadata-"));
    cleanup.push(tmpDir);
    const sessionFile = path.join(tmpDir, "agents", "main", "sessions", "sess-1.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "", "utf-8");

    const record = buildSupervisorDecisionRecord({
      sessionKey: "agent:main:thread-1",
      sessionId: "sess-1",
      event: {
        type: "user_message",
        category: "user",
        source: "slack",
        timestamp: 1,
        payload: { text: "switch to the outage" },
        urgency: "normal",
        scope: "foreground",
      },
      taskStateSnapshot: {
        sessionKey: "agent:main:thread-1",
        sessionId: "sess-1",
        phase: "acting",
        interruptPreference: "avoid",
        interruptibility: "interruptible",
        isActive: true,
        isStreaming: true,
        laneSize: 0,
      },
      relation: "new_task_replace",
      action: "abort_and_replace",
      classifier: { kind: "legacy_queue_translation" },
      rationale: { short: "replace" },
      metadata: {
        presentationPlan: {
          profile: "balanced",
          items: [
            {
              kind: "milestone",
              enabled: true,
              latencyClass: "deliberative",
              mode: "model",
              reason:
                "task replacement may warrant model-shaped wording once runtime wiring is ready",
              modelInputDraft: {
                audience_question: "Did you drop the old task and switch focus?",
                semantic_role:
                  "Only surface progress if the replacement task is long enough or yields a useful early result.",
                prompt_hint:
                  "If a milestone is shown, emphasize that the old task was dropped and the new task now owns focus.",
              },
            },
          ],
        },
      },
    });

    await appendSupervisorDecisionRecord({ sessionFile, record });

    await expect(readLatestSupervisorDecisionRecord(sessionFile)).resolves.toMatchObject({
      metadata: {
        presentationPlan: {
          items: [
            {
              kind: "milestone",
              modelInputDraft: {
                audience_question: "Did you drop the old task and switch focus?",
              },
            },
          ],
        },
      },
    });
  });
});
