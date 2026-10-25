import { expect, vi, type Mock } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { SessionPendingInput } from "../config/sessions/session-pending-input.types.js";
import { delivery, input, sourceSnapshot } from "./session-send-recovery.test-support.js";

/** Real notice storage and native keyed adoption under controlled recovery acknowledgments. */
export async function verifyRecoveryNoticeTurnOrdering(
  {
    io,
    sourceEntry,
    resumeChat,
    warn,
    recover,
  }: {
    io: { discover: Mock; pending: Mock; source: Mock; report: Mock };
    sourceEntry: { lifecycleRevision: string };
    resumeChat: Mock;
    warn: Mock;
    recover: () => Promise<void>;
  },
  signal: AbortSignal,
) {
  vi.useRealTimers();
  const { withOpenClawTestState } = await import("../test-utils/openclaw-test-state.js");
  const { upsertSessionEntryCore } =
    await import("../config/sessions/session-accessor.sqlite-entry.js");
  const { createUserTurnTranscriptRecorder } = await import("../sessions/user-turn-transcript.js");
  const { withSessionTurn } = await import("../sessions/session-controller.admission.js");
  const { SessionManager } = await import("../agents/sessions/session-manager.js");
  const reports = await import("../config/sessions/session-accessor.sqlite-transcript-reports.js");
  const { openOpenClawAgentDatabase } = await import("../state/openclaw-agent-db.js");
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = {
      agentId: "main",
      sessionKey: delivery.target.sessionKey,
      sessionId: delivery.target.sessionId,
      storePath: openOpenClawAgentDatabase({ agentId: "main" }).path,
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    io.discover.mockResolvedValue([{ agentId: "main", storePath: scope.storePath }]);
    const chat: SessionPendingInput = {
      id: "saved-chat",
      runId: "saved-chat",
      acceptedAt: Date.now(),
      state: "interrupted",
      message: {
        role: "user",
        content: "CHAT_UPDATE_1",
        timestamp: 1,
        idempotencyKey: "saved-chat:user",
        __openclaw: { chatInputRecovery: { version: 1 } },
      },
    };
    io.pending.mockResolvedValue({ items: [chat, input], total: 2 });
    io.source.mockImplementation((_scope, key) =>
      Promise.resolve(sourceSnapshot(key === chat.message.idempotencyKey ? chat : input)),
    );
    sourceEntry.lifecycleRevision = "source-after-reset";
    const admitted = createDeferred();
    const blocked = createDeferred();
    const resume = createDeferred();
    const noticeWritten = createDeferred();
    let execution: Promise<void> | undefined;
    let nativeFailure: unknown;
    let reportStarted = false;
    warn.mockImplementation((message: string) => {
      if (message.startsWith("Session delivery recovery blocked after")) {
        blocked.resolve();
      }
    });
    io.report.mockImplementation(async (target, report) => {
      reportStarted = true;
      try {
        return await reports.appendSessionTranscriptReport(target, report);
      } finally {
        noticeWritten.resolve();
      }
    });
    resumeChat.mockImplementation(async () => {
      execution = withSessionTurn(scope, async () => {
        const recorder = createUserTurnTranscriptRecorder({
          message: chat.message,
          target: { ...scope, sessionEntry: undefined },
        });
        await recorder.persistApproved();
        const manager = await SessionManager.openAsync(scope);
        admitted.resolve();
        await resume.promise;
        // The native runtime re-adopts the exact admitted user before its first provider request.
        await manager.appendMessageAsync(chat.message);
      }).catch((error: unknown) => {
        nativeFailure = error;
      });
      await withinTest(admitted.promise, signal);
    });
    const recovering = recover();
    try {
      await withinTest(blocked.promise, signal);
      // The last failed source proceeds synchronously to its notice write. On the
      // base this commits while the accepted chat is still preparing its model call.
      expect.soft(reportStarted).toBe(false);
      if (reportStarted) {
        await withinTest(noticeWritten.promise, signal);
      }
      resume.resolve();
      await withinTest(execution!, signal);
      await withinTest(recovering, signal);
      expect(nativeFailure).toBeUndefined();
      expect(
        await reports.readLatestSessionTranscriptReport(scope, ["session-send-recovery-blocked"]),
      ).toMatchObject({
        ok: true,
        value: { content: expect.stringContaining("session was reset or replaced") },
      });
    } finally {
      resume.resolve();
      await Promise.allSettled([execution, recovering]);
    }
  });
}
