import path from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  loadTranscriptEventsSync,
  readActiveTranscriptEntryAnchor,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { MAX_VISIBLE_MESSAGE_MAX_MESSAGES } from "../../config/sessions/session-accessor.sqlite-visible-cursor.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import { createSessionTranscriptHeader } from "../../config/sessions/transcript-header.js";
import { readPendingUserTurnTranscriptAdmission } from "../../sessions/user-turn-transcript-admission.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareMemoryFlushSession } from "./memory-flush-session.js";

async function withAdmittedInput(
  compacted: boolean,
  run: (fixture: {
    source: SessionManager;
    scope: { agentId: string; sessionId: string; sessionKey: string; storePath: string };
    workspaceDir: string;
    recorder: ReturnType<typeof createUserTurnTranscriptRecorder>;
    admission: NonNullable<ReturnType<typeof readPendingUserTurnTranscriptAdmission>>;
    priorContext: ReturnType<SessionManager["buildSessionContext"]>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "memory-checkpoint" }, async (state) => {
    setRuntimeConfigSnapshot({});
    onTestFinished(() => clearRuntimeConfigSnapshot());
    const scope = {
      agentId: "main",
      sessionId: "foreground-session",
      sessionKey: "agent:main:foreground",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const source = SessionManager.open(scope, state.workspaceDir);
    source.appendMessage({ role: "user", content: "Earlier topic", timestamp: 1 });
    source.appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "Earlier reply" }],
        stopReason: "stop",
      }),
    );
    const retained = source.appendMessage(makeUserMessage("Keep the Cedar project receipt.", 3));
    source.appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "Cedar receipt is maple-17." }],
        stopReason: "stop",
      }),
    );
    if (compacted) {
      source.appendCompaction("Earlier conversation summary", retained, 500);
      const excluded = {
        role: "user" as const,
        content: "Excluded diagnostic payload",
        timestamp: 4,
        excludeFromContext: true as const,
      };
      source.appendMessage(excluded);
      source.appendCustomEntry("openclaw:bootstrap-context:full", { revision: "fixture" });
    }
    await waitForSessionTranscriptProjection(scope);
    const priorContext = source.buildSessionContext();
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: "Unprocessed current question: do not checkpoint this yet.",
        idempotencyKey: "foreground:user",
      },
      target: { ...scope, expectedSessionId: scope.sessionId, sessionEntry: undefined },
    });
    await recorder.persistApproved();
    const admission = readPendingUserTurnTranscriptAdmission(recorder);
    if (!admission) {
      throw new Error("Fixture failed to admit its current user");
    }
    await run({
      source,
      scope,
      workspaceDir: state.workspaceDir,
      recorder,
      admission,
      priorContext,
    });
  });
}

it("isolates a required checkpoint while preserving compacted admitted input", async () => {
  await withAdmittedInput(true, async ({ scope, workspaceDir, admission, priorContext }) => {
    const before = loadTranscriptEventsSync(scope);
    const anchor = readActiveTranscriptEntryAnchor(admission);
    const sourceWithForeignAuthority = {
      ...scope,
      expectedWriterRunId: "foreground-writer",
      threadId: "foreground-native-thread",
    };
    const checkpoint = await prepareMemoryFlushSession({
      admission,
      source: sourceWithForeignAuthority,
      runId: "memory-helper",
      workspaceDir,
    });
    expect(checkpoint.sessionManager.getSessionTarget()).toBeUndefined();
    expect(checkpoint.sessionManager.buildSessionContext().messages).toEqual(priorContext.messages);
    expect(checkpoint.sessionId).not.toBe(scope.sessionId);
    expect(checkpoint.sessionKey).not.toBe(scope.sessionKey);
    expect(checkpoint.sessionTarget).not.toHaveProperty("expectedWriterRunId");
    expect(checkpoint.sessionTarget).not.toHaveProperty("threadId");
    expect(checkpoint.sessionPersistence).toBe("detached");
    const first = checkpoint.sessionManager.getBranch()[0];
    if (first) {
      if (first.type === "message" && first.message.role === "user") {
        first.message.content = "Checkpoint-only edit";
      }
      checkpoint.sessionManager.branch(first.id);
    }
    const instruction = checkpoint.sessionManager.appendMessage(
      makeUserMessage("Checkpoint instruction", 5),
    );
    checkpoint.sessionManager.appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "NO_REPLY" }],
        stopReason: "stop",
      }),
    );
    checkpoint.sessionManager.appendCompaction("Checkpoint-only summary", instruction, 100);
    expect(loadTranscriptEventsSync(scope)).toEqual(before);
    expect(readActiveTranscriptEntryAnchor(admission)).toEqual(anchor);
    expect(SessionManager.open(scope).getBranch().at(-1)?.id).toBe(admission.entryId);
  });
});

it("does not acquire a checkpoint after caller cancellation", async () => {
  await withAdmittedInput(false, async ({ scope, workspaceDir, admission }) => {
    const before = loadTranscriptEventsSync(scope);
    const reason = new Error("cancel required checkpoint");
    await expect(
      prepareMemoryFlushSession({
        admission,
        source: scope,
        runId: "cancelled-helper",
        workspaceDir,
        signal: AbortSignal.abort(reason),
      }),
    ).rejects.toBe(reason);
    expect(loadTranscriptEventsSync(scope)).toEqual(before);
  });
});

it("preserves empty transcript header handling during detached acquisition", async () => {
  await withOpenClawTestState({ label: "memory-header-empty" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "header-checkpoint",
      sessionKey: "agent:main:header-checkpoint",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const before = loadTranscriptEventsSync(scope);
    const memory = await prepareMemoryFlushSession({
      source: scope,
      runId: "header-memory-helper",
      workspaceDir: state.workspaceDir,
    });
    expect(memory.sessionManager.getSessionTarget()).toBeUndefined();
    expect(memory.sessionManager.getHeader()).toMatchObject({ id: scope.sessionId });
    expect(memory.sessionManager.buildSessionContext().messages).toEqual([]);
    expect(loadTranscriptEventsSync(scope)).toEqual(before);
  });
});

it("rejects a partial bounded checkpoint instead of silently starting with less history", async () => {
  await withOpenClawTestState({ label: "bounded-memory-checkpoint" }, async (state) => {
    setRuntimeConfigSnapshot({});
    onTestFinished(() => clearRuntimeConfigSnapshot());
    const scope = {
      agentId: "main",
      sessionId: "bounded-checkpoint",
      sessionKey: "agent:main:bounded-checkpoint",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const seed = SessionManager.fromEntries([
      createSessionTranscriptHeader({ cwd: state.workspaceDir, sessionId: scope.sessionId }),
    ]);
    for (let i = 0; i <= MAX_VISIBLE_MESSAGE_MAX_MESSAGES; i += 1) {
      seed.appendMessage({ role: "user", content: `Prior record ${i}`, timestamp: i });
    }
    await replaceTranscriptEvents(scope, [seed.getHeader(), ...seed.getEntries()]);
    const recorder = createUserTurnTranscriptRecorder({
      target: { ...scope, expectedSessionId: scope.sessionId, sessionEntry: undefined },
      input: { text: "Current request", idempotencyKey: "bounded:user" },
    });
    await recorder.persistApproved();
    const admission = readPendingUserTurnTranscriptAdmission(recorder);
    if (!admission) {
      throw new Error("Missing bounded fixture admission");
    }
    const before = loadTranscriptEventsSync(scope);
    await expect(
      prepareMemoryFlushSession({
        admission,
        source: scope,
        runId: "bounded-helper",
        workspaceDir: state.workspaceDir,
      }),
    ).rejects.toThrow("bounded conversation view");
    expect(loadTranscriptEventsSync(scope)).toEqual(before);
  });
});
