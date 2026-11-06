// Preserve registry fixture setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "../../agents/subagents/registry/subagent-control.test-support.js";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import * as persistence from "../../agents/subagents/registry/subagent-registry-persistence.js";
import { registerSubagentRun } from "../../agents/subagents/registry/subagent-registry.js";
import { getRuntimeConfig } from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import { executePreparedReplyAgentRun } from "./agent-runner-execute.js";
import {
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  setupAgentRunnerExecutionTestState,
} from "./agent-runner-execution.test-support.js";
import { createReplyActorFixture } from "./reply-actor.test-support.js";
import { createReplyInputAdmission } from "./reply-input-admission.js";
import { createMockTypingController } from "./test-helpers.js";

const fixture = useSubagentControlFixture();
const state = await setupAgentRunnerExecutionTestState();

it("settles a reply visibly when the reactivation cohort changes before replacement", async () => {
  const sessionKey = "agent:main:subagent:cohort-conflict";
  const target = {
    agentId: "main",
    sessionId: "child-session",
    sessionKey,
    storePath: path.join(fixture.stateDir, "agents", "main", "openclaw-agent.sqlite"),
  };
  let entry: InternalSessionEntry = { sessionId: target.sessionId, updatedAt: 1, spawnDepth: 1 };
  await replaceSessionEntry(target, entry);
  const recorder = createUserTurnTranscriptRecorder({
    input: { text: "Continue the completed task", idempotencyKey: "reply-followup:user" },
    target: { ...target, sessionEntry: entry },
  });
  await registerSubagentRun({
    runId: "completed-task",
    childSessionKey: sessionKey,
    childAgentId: "main",
    sessionEntry: { sessionId: "child-session" },
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "completed task",
    cleanup: "keep",
    expectsCompletionMessage: false,
  });
  await persistence.mutateSubagentRuns(["completed-task"], (rows) => ({
    value: undefined,
    postimages: new Map([
      [
        "completed-task",
        {
          ...rows.get("completed-task")!,
          execution: { status: "terminal", startedAt: 1, endedAt: 2, outcome: { status: "ok" } },
        },
      ],
    ]),
  }));
  const mutate = persistence.mutateSubagentRuns;
  let changedCohort = false;
  vi.spyOn(persistence, "mutateSubagentRuns").mockImplementation(async (ids, plan, options) => {
    if (ids.includes("reply-followup") && !changedCohort) {
      changedCohort = true;
      // A concurrent publisher extends the frozen batch after replacement selected its rows.
      await mutate(["completed-task"], (rows) => ({
        value: undefined,
        postimages: new Map([
          [
            "completed-task",
            {
              ...rows.get("completed-task")!,
              requesterSettleWake: {
                status: "pending",
                attemptCount: 0,
                batchRunIds: ["completed-task", "new-cohort-member"],
              },
            },
          ],
        ]),
      }));
    }
    return mutate(ids, plan, options);
  });
  await using actor = createReplyActorFixture({
    ...target,
    getSessionId: () => target.sessionId,
  });
  const { operation: replyOperation } = await actor.bind();
  const failMock = vi.spyOn(replyOperation, "fail");
  const followupRun = createFollowupRun({
    config: getRuntimeConfig(),
    sessionKey,
    sessionId: target.sessionId,
  });
  followupRun.userTurnTranscriptRecorder = recorder;
  const admission = createReplyInputAdmission({
    followupRun,
    replyOperation,
    sessionKey,
    storePath: target.storePath,
    sourceTurnId: "reply-followup",
    setEntry: (next) => {
      entry = next;
    },
  });
  const result = await executePreparedReplyAgentRun({
    ...createMinimalRunAgentTurnParams({
      followupRun,
      opts: { runId: "reply-followup" },
      replyOperation,
    }),
    ...target,
    ...admission,
    replyOperation,
    activeIsNewSession: false,
    activeSessionStore: undefined,
    cfg: getRuntimeConfig(),
    defaultModel: "test",
    queueKey: sessionKey,
    resolvedQueue: { mode: "followup" },
    shouldInjectGroupIntro: false,
    preflightCompactionApplied: false,
    replyMediaContext: { normalizePayload: async (payload) => payload },
    replyRouteThreadId: undefined,
    replyToChannel: "webchat",
    replyToMode: "off",
    typing: createMockTypingController(),
    typingMode: "never",
    getActiveSessionEntry: () => entry,
    onCompactionNoticePayload: () => {},
    resolveVisibleReplyDelivery: async () => false,
    returnWithQueuedFollowupDrain: (value) => value,
    setRunFollowupTurn: () => {},
    runFollowupTurn: async () => {},
    traceAgentPhase: async (_name, run) => await run(),
  });

  expect(changedCohort).toBe(true);
  expect(result).toMatchObject({ text: expect.stringContaining("couldn't finish this request") });
  if (!result || Array.isArray(result)) {
    throw new Error("Expected one visible continuation failure");
  }
  expect(getReplyPayloadMetadata(result)?.deliverDespiteSourceReplySuppression).toBe(true);
  expect(recorder.hasPersisted()).toBe(true);
  expect(await SessionManager.readSessionContextAsync(target, (rows) => [...rows])).toEqual([
    expect.objectContaining({ role: "user", content: "Continue the completed task" }),
  ]);
  expect(failMock).toHaveBeenCalledWith(
    "run_failed",
    expect.objectContaining({ message: "Replacement subagent cohort changed" }),
  );
  expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
  expect(subagentRuns.has("reply-followup")).toBe(false);
  expect(subagentRuns.get("completed-task")?.execution.status).toBe("terminal");
  await fixture.settle();
});
