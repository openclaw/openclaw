import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { CURRENT_SESSION_VERSION } from "../config/sessions/version.js";
import { createSessionGoalFixture } from "./session-goal.test-support.js";

export const target = {
  agentId: "main",
  sessionId: "failed-turn-session",
  sessionKey: "agent:main:main",
};
export const runId = "failed-turn-run";
export const error = "Worker turn rejected: cloud worker unavailable";
export const event = {
  sessionId: target.sessionId,
  runId,
  ts: 2_000,
  data: { phase: "error", startedAt: 1_000, endedAt: 2_000, error },
};

export async function seed(
  assistantBranch?: "active" | "inactive" | "other-run" | "commentary" | "success",
) {
  const hasPriorOutput = assistantBranch === "commentary" || assistantBranch === "success";
  await upsertSessionEntryCore(target, {
    sessionId: target.sessionId,
    updatedAt: 1_000,
    startedAt: 1_000,
    lifecycleRunId: runId,
    activeWriterRunId: runId,
    goal: createSessionGoalFixture("failure-goal", "Finish the requested work", {
      createdAt: 1_000,
      updatedAt: 1_000,
    }),
  });
  await replaceTranscriptEvents(target, [
    { type: "session", id: target.sessionId, version: CURRENT_SESSION_VERSION },
    {
      type: "message",
      id: "user-turn",
      parentId: null,
      message: { role: "user", content: "Please continue." },
    },
    ...(assistantBranch
      ? [
          {
            type: "message",
            id: "assistant-error",
            parentId: "user-turn",
            message: {
              role: "assistant",
              content: hasPriorOutput
                ? [
                    {
                      type: "text",
                      text: "Running it now.",
                      ...(assistantBranch === "commentary"
                        ? {
                            textSignature: JSON.stringify({
                              v: 1,
                              id: "commentary",
                              phase: "commentary",
                            }),
                          }
                        : {}),
                    },
                  ]
                : [],
              stopReason: hasPriorOutput ? "stop" : "error",
              errorMessage: hasPriorOutput ? undefined : "Provider failed",
              __openclaw: { runId: assistantBranch === "other-run" ? "previous-run" : runId },
            },
          },
        ]
      : []),
    ...(assistantBranch === "inactive"
      ? [
          {
            type: "leaf",
            id: "selected-branch",
            parentId: "assistant-error",
            targetId: "user-turn",
          },
        ]
      : []),
  ]);
}

export async function reports() {
  return (await loadTranscriptEvents(target)).filter(
    (entry) => isRecord(entry) && entry.customType === "run-failed-before-reply",
  );
}
