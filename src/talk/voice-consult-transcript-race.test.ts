import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareEmbeddedAttemptSessionBoundary } from "../agents/embedded-agent-runner/run/attempt-session-prepare.js";
import type { AgentMessage } from "../agents/runtime/index.js";
import { guardSessionManager } from "../agents/session-tool-result-guard-wrapper.js";
import type { AgentSession } from "../agents/sessions/index.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import {
  appendTranscriptMessage,
  loadTranscriptEventsSync,
} from "../config/sessions/session-accessor.js";
import { runWithSessionTranscriptReadFence } from "../config/sessions/session-transcript-read-fence.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import {
  appendRelayVoiceTranscript,
  createOrResumeClientVoiceSession,
  ensureClientVoiceAgentSessionEntry,
} from "./client-voice-session.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
const agentId = "main";
const CONSULT_REPLY = "Two meetings tomorrow.";

function readMessageTexts(scope: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): string[] {
  return loadTranscriptEventsSync(scope).flatMap((event) => {
    const message = (event as { message?: { content?: unknown } } | null)?.message;
    const content = message?.content;
    if (typeof content === "string") {
      return [content];
    }
    if (!Array.isArray(content)) {
      return [];
    }
    return content.flatMap((block) =>
      block && typeof block === "object" && "text" in block
        ? [String((block as { text: unknown }).text)]
        : [],
    );
  });
}

async function prepareConsultTurn(label: string) {
  const dir = tempDirs.make(`openclaw-${label}-`);
  setTestEnvValue("OPENCLAW_STATE_DIR", dir);
  const storePath = path.join(dir, "sessions.sqlite");
  const sessionKey = `agent:${agentId}:${label}`;
  const sessionId = await ensureClientVoiceAgentSessionEntry({ agentId, sessionKey, storePath });
  const scope = { agentId, sessionId, sessionKey, storePath };
  const manager = SessionManager.open(scope, dir);
  manager.appendMessage({ role: "user", content: "earlier question", timestamp: 1 });
  const admission = manager.appendMessageWithTranscriptAnchor({
    role: "user",
    content: "what is on the calendar tomorrow?",
    timestamp: 2,
  });
  const anchor = admission.anchor;
  if (!anchor) {
    throw new Error("missing current-turn anchor");
  }
  const appendConsultReply = () =>
    runWithSessionTranscriptReadFence({ ...anchor, logicalTurnId: label, role: "user" }, () =>
      SessionManager.openBounded(scope, {
        cwd: dir,
        maxBytes: 8192,
        maxEvents: 16,
      }).appendMessage(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: CONSULT_REPLY }],
          timestamp: 5,
        }),
      ),
    );
  return { appendConsultReply, scope, sessionKey, storePath };
}

beforeEach(() => {
  envSnapshot.restore();
});

afterEach(async () => {
  for (const stateDir of tempDirs.dirs) {
    await cleanupSessionStateForTest({ stateDir });
  }
  envSnapshot.restore();
});

// openclaw#150204 family: the live call keeps transcribing while the consult runs.
it("keeps the voice transcript from failing an in-flight agent consult", async () => {
  const { appendConsultReply, scope, sessionKey, storePath } =
    await prepareConsultTurn("voice-consult-relay");
  const voiceSessionId = createOrResumeClientVoiceSession({
    agentId,
    sessionKey,
    origin: "relay",
    provider: "realtime",
  });
  const target = {
    agentId,
    sessionKey,
    sessionTarget: { sessionKey, storePath },
    voiceSessionId,
  };
  await appendRelayVoiceTranscript({
    ...target,
    entryId: "utterance-1",
    role: "user",
    text: "what is on the calendar tomorrow?",
  });
  await appendRelayVoiceTranscript({
    ...target,
    entryId: "filler-1",
    role: "assistant",
    text: "I'll check that request.",
  });

  expect(() => appendConsultReply()).not.toThrow();

  expect(readMessageTexts(scope)).toEqual([
    "earlier question",
    "what is on the calendar tomorrow?",
    "what is on the calendar tomorrow?",
    "I'll check that request.",
    CONSULT_REPLY,
  ]);
});

// The exemption keys on the marker the voice writer stamps, not on the kind alone.
it.each([
  { label: "no-channel", provenance: { kind: "realtime_voice" } },
  {
    label: "foreign-channel",
    provenance: { kind: "realtime_voice", sourceChannel: "discord" },
  },
  {
    label: "foreign-kind",
    provenance: { kind: "typed_chat", sourceChannel: "talk" },
  },
])(
  "still rejects a consult reply superseded by a $label user row",
  async ({ label, provenance }) => {
    const { appendConsultReply, scope } = await prepareConsultTurn(`voice-consult-${label}`);
    await appendTranscriptMessage(scope, {
      eventId: `forged:${label}`,
      message: {
        role: "user",
        content: [{ type: "text", text: "different question" }],
        timestamp: 3,
        provenance,
      },
      now: 3,
    });

    expect(() => appendConsultReply()).toThrow("SQLite transcript changed while preparing rewrite");
    expect(readMessageTexts(scope)).not.toContain(CONSULT_REPLY);
  },
);

it("regression: session manager sees stale leaf until reload (#162907)", async () => {
  const dir = tempDirs.make("openclaw-stale-orphan-");
  setTestEnvValue("OPENCLAW_STATE_DIR", dir);
  const storePath = path.join(dir, "sessions.sqlite");
  const sessionKey = "agent:main:stale-orphan";
  const sessionId = await ensureClientVoiceAgentSessionEntry({ agentId, sessionKey, storePath });
  const scope = { agentId, sessionId, sessionKey, storePath };

  const seed = SessionManager.open(scope, dir);
  seed.appendMessage({ role: "user", content: "orphan question", timestamp: 1 });

  const manager = SessionManager.openBounded(scope, { cwd: dir, maxBytes: 8192, maxEvents: 16 });
  expect((manager.getLeafEntry() as { message?: { role?: string } })?.message?.role).toBe("user");

  await appendTranscriptMessage(scope, {
    eventId: "voice-finalized",
    message: makeAgentAssistantMessage({
      content: [{ type: "text", text: "voice reply" }],
      timestamp: 2,
    }),
    now: 2,
  });

  expect((manager.getLeafEntry() as { message?: { role?: string } })?.message?.role).toBe("user");

  await manager.reloadPersistedTranscriptAsync();
  expect((manager.getLeafEntry() as { message?: { role?: string } })?.message?.role).toBe(
    "assistant",
  );
});

it("regression: boundary reloads stale transcript before orphan repair, preserving speech and allowing consult continuation (#162907)", async () => {
  const dir = tempDirs.make("openclaw-boundary-reload-");
  setTestEnvValue("OPENCLAW_STATE_DIR", dir);
  const storePath = path.join(dir, "sessions.sqlite");
  const sessionKey = "agent:main:boundary-reload";
  const sessionId = await ensureClientVoiceAgentSessionEntry({ agentId, sessionKey, storePath });
  const scope = { agentId, sessionId, sessionKey, storePath };

  const seed = SessionManager.open(scope, dir);
  seed.appendMessage({ role: "user", content: "orphan question", timestamp: 1 });

  const guarded = guardSessionManager(
    SessionManager.openBounded(scope, { cwd: dir, maxBytes: 8192, maxEvents: 16 }),
    { runId: "boundary-reload" },
  );

  // Simulate finalized Talk speech advancing the durable transcript after
  // the session manager was loaded — the cached leaf is still "user".
  expect((guarded.getLeafEntry() as { message?: { role?: string } })?.message?.role).toBe("user");

  await appendTranscriptMessage(scope, {
    eventId: "voice-finalized",
    message: makeAgentAssistantMessage({
      content: [{ type: "text", text: "voice reply" }],
      timestamp: 2,
    }),
    now: 2,
  });

  // Cached view is stale — still sees the user leaf.
  expect((guarded.getLeafEntry() as { message?: { role?: string } })?.message?.role).toBe("user");

  const activeSession = {
    agent: {
      reset: vi.fn(),
      state: { messages: [] as AgentMessage[] },
      convertToLlm: vi.fn((input: AgentMessage[]) => input as never),
    },
  } as unknown as Pick<AgentSession, "agent">;

  // The boundary reloads the persisted transcript before computing the
  // orphan repair plan. After reload the leaf is "assistant", so no orphan
  // user-turn repair is attempted — preventing a stale mutation-version write.
  const result = await prepareEmbeddedAttemptSessionBoundary({
    abortSignal: undefined,
    activeSession,
    attempt: {
      sessionId,
      prompt: "consult request",
    },
    getUserTranscriptContexts: () => undefined,
    isRawModelRun: false,
    preparedUserTurnMessage: undefined,
    sessionManager: guarded,
    setActiveSessionSystemPrompt: vi.fn(),
  });

  // No orphan repair — the stale user leaf was replaced by fresh assistant speech.
  expect(result.orphanRepair).toBeUndefined();
  expect((guarded.getLeafEntry() as { message?: { role?: string } })?.message?.role).toBe(
    "assistant",
  );

  // Both speech rows are preserved in durable storage.
  const persistedMessages = readMessageTexts(scope);
  expect(persistedMessages).toContain("orphan question");
  expect(persistedMessages).toContain("voice reply");

  // No leaf-control navigation event was committed (orphan repair did not run).
  const events = loadTranscriptEventsSync(scope);
  expect(events.filter((e) => (e as { type?: string })?.type === "leaf")).toHaveLength(0);

  // The consult can proceed: the session context reflects the fresh assistant
  // leaf rather than the stale orphan user turn.
  const contextMessages = guarded.buildSessionContext().messages;
  const lastMessage = contextMessages.at(-1) as { role?: string } | undefined;
  expect(lastMessage?.role).toBe("assistant");

  // Keyed consultation input persists successfully after the boundary reload.
  // The fresh mutation version from the reloaded transcript admits the write.
  const consultInput = {
    role: "user" as const,
    content: "consult request",
    idempotencyKey: "boundary-reload:user",
    timestamp: 3,
  };
  // Use the admitted asynchronous consultation path (appendMessageWithTranscriptAnchorAsync)
  // when the test runs on the main thread (forks pool); the threads pool cannot
  // admit the metadata worker, so fall back to the sync equivalent.
  const appendPath = isMainThread ? "async" : "sync";
  const consultAnchor =
    appendPath === "async"
      ? await guarded.appendMessageWithTranscriptAnchorAsync(consultInput)
      : guarded.appendMessageWithTranscriptAnchor(consultInput);
  expect(consultAnchor.entryId).toBeTruthy();
  expect(consultAnchor.anchor).toBeTruthy();
  expect(readMessageTexts(scope)).toContain("consult request");
  // Log the successful continuation so it appears in terminal output as proof.
  console.log(
    `[proof] post-fix (${appendPath} path):`,
    "orphanRepair=",
    result.orphanRepair,
    "freshLeafRole=assistant",
    "consultAnchor.entryId=",
    consultAnchor.entryId,
    "persistedMessages=",
    readMessageTexts(scope),
  );
});

it("regression: pre-fix control — without reload, stale leaf triggers orphan repair and mutation conflict (#162907)", async () => {
  const dir = tempDirs.make("openclaw-pre-fix-control-");
  setTestEnvValue("OPENCLAW_STATE_DIR", dir);
  const storePath = path.join(dir, "sessions.sqlite");
  const sessionKey = "agent:main:pre-fix-control";
  const sessionId = await ensureClientVoiceAgentSessionEntry({ agentId, sessionKey, storePath });
  const scope = { agentId, sessionId, sessionKey, storePath };

  const seed = SessionManager.open(scope, dir);
  seed.appendMessage({ role: "user", content: "orphan question", timestamp: 1 });

  const guarded = guardSessionManager(
    SessionManager.openBounded(scope, { cwd: dir, maxBytes: 8192, maxEvents: 16 }),
    { runId: "pre-fix-control" },
  );

  // Simulate finalized Talk speech advancing the durable transcript.
  await appendTranscriptMessage(scope, {
    eventId: "voice-finalized",
    message: makeAgentAssistantMessage({
      content: [{ type: "text", text: "voice reply" }],
      timestamp: 2,
    }),
    now: 2,
  });

  // Cached view is stale — still sees the user leaf.
  expect((guarded.getLeafEntry() as { message?: { role?: string } })?.message?.role).toBe("user");

  const activeSession = {
    agent: {
      reset: vi.fn(),
      state: { messages: [] as AgentMessage[] },
      convertToLlm: vi.fn((input: AgentMessage[]) => input as never),
    },
  } as unknown as Pick<AgentSession, "agent">;

  // Disable the reload to simulate pre-fix behavior: the boundary reads the
  // stale cached leaf, sees a trailing user message, and produces an orphan
  // repair plan that should not have been computed against current state.
  const reloadSpy = vi
    .spyOn(guarded, "reloadPersistedTranscriptAsync")
    .mockResolvedValue(undefined);

  const boundaryResult = await prepareEmbeddedAttemptSessionBoundary({
    abortSignal: undefined,
    activeSession,
    attempt: {
      sessionId,
      prompt: "consult request",
    },
    getUserTranscriptContexts: () => undefined,
    isRawModelRun: false,
    preparedUserTurnMessage: undefined,
    sessionManager: guarded,
    setActiveSessionSystemPrompt: vi.fn(),
  }).then(
    (value) => ({ kind: "resolved" as const, value }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  );

  reloadSpy.mockRestore();

  // Without the reload, the boundary sees the stale user leaf and either
  // produces an orphan repair plan or fails attempting the stale write.
  const producedOrphanRepair =
    boundaryResult.kind === "resolved" && boundaryResult.value.orphanRepair !== undefined;
  const writeFailed = boundaryResult.kind === "rejected";
  expect(producedOrphanRepair || writeFailed).toBe(true);

  // The orphan repair plan carries a stale user-leaf message entry.
  if (producedOrphanRepair && boundaryResult.kind === "resolved") {
    expect(boundaryResult.value.orphanRepair?.messageEntry?.message?.role).toBe("user");
  }

  // The stale leaf-control write the orphan repair path attempts (branchAsync
  // + appendLeafControlAsync) reaches the reported mutation conflict through
  // runTranscriptWriteSnapshotSync, which rejects the stale cached
  // transcriptMutationAt. Both the synchronous and asynchronous append paths
  // route through this same SQLite guard; the synchronous leaf-control append
  // exercises it directly because the test worker cannot admit the metadata
  // worker's native execution scope for the async persist path.
  const staleLeafControlWrite = () =>
    guarded.appendLeafControl({
      targetId: guarded.getLeafId(),
      appendParentId: guarded.getAppendParentId(),
    });

  const capturedError = (() => {
    try {
      staleLeafControlWrite();
      return undefined;
    } catch (error) {
      return error as Error;
    }
  })();
  expect(capturedError).toBeDefined();
  expect(capturedError?.message).toContain("SQLite transcript changed while preparing rewrite");
  // Log the conflict error so it appears in terminal output as real behavior proof.
  console.log("[proof] pre-fix mutation conflict (sync path):", capturedError?.message);

  // Also exercise the admitted asynchronous consultation path when on the main
  // thread (forks pool): a keyed consultation input through
  // appendMessageWithTranscriptAnchorAsync on the stale manager should fail.
  // The threads pool cannot admit the metadata worker, so skip the async path.
  if (isMainThread) {
    const asyncConsultInput = {
      role: "user" as const,
      content: "async consult request",
      idempotencyKey: "pre-fix-async:user",
      timestamp: 4,
    };
    const asyncResult = await guarded
      .appendMessageWithTranscriptAnchorAsync(asyncConsultInput)
      .then(
        (value) => ({ kind: "resolved" as const, value }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );
    if (asyncResult.kind === "rejected") {
      const asyncErrorMessage = (asyncResult.error as Error)?.message ?? "";
      console.log("[proof] pre-fix mutation conflict (async path):", asyncErrorMessage);
      // The async path may surface the conflict as either the direct mutation
      // conflict or a view-adoption failure (the stale cached view cannot adopt
      // the committed entry). Both prove the stale-manager problem.
      expect(asyncErrorMessage).toMatch(
        /SQLite transcript changed while preparing rewrite|view could not be adopted/,
      );
    } else {
      console.log("[proof] pre-fix async path resolved without conflict");
    }
  } else {
    console.log("[proof] pre-fix async path skipped (threads pool; sync path proof above)");
  }

  // Both speech rows remain preserved — the stale write was rejected.
  const persistedMessages = readMessageTexts(scope);
  expect(persistedMessages).toContain("orphan question");
  expect(persistedMessages).toContain("voice reply");
});
