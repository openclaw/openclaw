/**
 * A restart-safe Control-UI admission that ends terminal must count as unread
 * activity: the user never saw the reply, so the session list has to mark it.
 */
import path from "node:path";
import { expect, it } from "vitest";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { deriveSessionUnread } from "../../shared/session-unread.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { terminalizeRestartSafeChatAdmission } from "./chat-restart-recovery.js";

it("counts a terminal restart-safe admission as unread activity", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const target = {
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "restart-safe-unread-session",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    const runId = "restart-safe-unread-run";
    await upsertSessionEntryCore(target, {
      sessionId: target.sessionId,
      createdAt: 1_000,
      lastReadAt: 1_000,
      updatedAt: 1_000,
      startedAt: 1_000,
      lifecycleRunId: runId,
      status: "running",
      restartRecoveryDeliveryRunId: runId,
      restartRecoveryDeliverySourceRunId: runId,
    });
    expect(deriveSessionUnread(loadSessionEntry(target))).toBe(false);

    expect(
      await terminalizeRestartSafeChatAdmission({
        ...target,
        admittedSessionId: target.sessionId,
        clientRunId: runId,
        startedAt: 1_000,
        error: "Cloud worker unavailable",
        status: "failed",
        retryable: false,
      }),
    ).toBe(true);

    const entry = loadSessionEntry(target);
    expect(entry).toMatchObject({ status: "failed" });
    expect(entry?.restartRecoveryDeliveryRunId).toBeUndefined();
    // The reply never reached the user, so the session must read as unread.
    expect(deriveSessionUnread(entry)).toBe(true);
  });
});
