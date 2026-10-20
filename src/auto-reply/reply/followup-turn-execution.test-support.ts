import assert from "node:assert/strict";
import { vi } from "vitest";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { createTurn } from "./followup-delivery.test-helpers.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import type { FollowupRun } from "./queue/types.js";
import type { AdmittedFollowupTurn } from "./reply-agent-turn-preparation.js";
import { createMockTypingController } from "./test-helpers.js";

const followupTurnTestState = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock("./agent-runner-execution.js", () => ({
  executeAgentTurn: followupTurnTestState.execute,
}));

// mock-isolation: Forward the real persistence owners without loading the unrelated accessor barrel graph.
vi.mock("../../config/sessions/session-accessor.js", async () => {
  const { bindSessionPendingInputSources, withSessionPendingInputPersistence } =
    await import("../../config/sessions/session-accessor.pending-inputs.js");
  const { loadSessionEntry, patchSessionEntryTarget, replaceSessionEntry } =
    await import("../../config/sessions/session-accessor.sqlite-entry.js");
  const { persistSessionTranscriptTurn } =
    await import("../../config/sessions/session-accessor.transcript-turn.js");
  return {
    bindSessionPendingInputSources,
    loadSessionEntry,
    patchSessionEntryTarget,
    persistSessionTranscriptTurn,
    replaceSessionEntry,
    withSessionPendingInputPersistence,
  };
});

const { executeFollowupTurn } = await import("./followup-turn-execution.js");

export const executeFollowupTurnForTest = executeFollowupTurn;

export function getFollowupTurnTestState() {
  return followupTurnTestState;
}

export const createFollowupTurnTestTypingController = createMockTypingController;

export function createFollowupTurnTestTurn(
  overrides: Partial<AdmittedFollowupTurn> = {},
): AdmittedFollowupTurn {
  const base = createTurn();
  return {
    ...base,
    queued: {
      ...base.queued,
      prompt: "queued prompt",
      transcriptPrompt: "queued transcript",
      messageId: "message-1",
      originatingThreadId: "thread-1",
      originatingAccountId: "acct-1",
      originatingChatType: "group",
      media: [{ kind: "audio", contentType: "audio/ogg" }],
      run: {
        ...base.queued.run,
        messageProvider: "slack",
        senderId: "user-1",
      },
    },
    session: {
      kind: "session",
      key: "main",
      current: () => ({ sessionId: "session", updatedAt: 1, verboseLevel: "on" }),
      publish: () => undefined,
    },
    ...overrides,
  };
}

export async function executeQueuedFollowupTurnForTest(
  queued: FollowupRun,
  params: { runId: string; opts?: InternalGetReplyOptions; admit: boolean },
) {
  let turn = createFollowupTurnTestTurn({
    runId: params.runId,
    queued,
    config: queued.run.config,
  });
  const defaults = {
    typing: createFollowupTurnTestTypingController(),
    typingMode: "never" as const,
    defaultModel: "claude",
    opts: params.opts,
  };
  let admittedOperation: AdmittedFollowupTurn["operation"] | undefined;
  try {
    if (params.admit) {
      const [{ prepareReplyAgentTurn }, replyAdmission, configuredOwners] = await Promise.all([
        import("./reply-agent-turn-preparation.js"),
        import("./reply-turn-admission.js"),
        import("../../state/user-channel-identity-operations.js"),
      ]);
      const lease = vi
        .spyOn(replyAdmission, "admitReplyTurn")
        .mockImplementationOnce(async ({ captureRunSelection, mailboxClaim }) => {
          captureRunSelection?.();
          assert(mailboxClaim, "queued admission must own its selected source");
          admittedOperation = createReplyOperation({
            sessionKey: queued.run.sessionKey ?? queued.run.sessionId,
            sessionId: queued.run.sessionId,
            agentId: queued.run.agentId,
            resetTriggered: false,
            turnKind: "queued_followup",
            mailboxClaim,
          });
          return { status: "owned", operation: admittedOperation };
        });
      const durableOwner = vi
        .spyOn(configuredOwners, "prepareConfiguredCommandOwnerAuthority")
        .mockResolvedValue(undefined);
      try {
        const admission = await prepareReplyAgentTurn({ queued, defaults });
        assert(admission.kind === "admitted", "Expected queued owner admission");
        turn = admission.turn;
      } finally {
        lease.mockRestore();
        durableOwner.mockRestore();
      }
    }
    return await executeFollowupTurn({
      turn,
      defaults,
      onToolResult: async () => {},
      onCompactionNoticePayload: async () => {},
    });
  } finally {
    try {
      await turn.releaseSourceAdmission?.();
    } finally {
      admittedOperation?.complete();
      await admittedOperation?.ownerSettlement;
    }
  }
}

export function resetFollowupTurnTestState() {
  vi.clearAllMocks();
  followupTurnTestState.execute.mockResolvedValue({
    runId: "run-1",
    outcome: { kind: "rejected", payload: { text: "done" } },
  });
}
