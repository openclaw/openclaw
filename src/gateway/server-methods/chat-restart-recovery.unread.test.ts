/**
 * A restart-safe Control-UI admission that ends terminal must count as unread
 * activity: the user never saw the reply, so the session list has to mark it.
 * Internal Goal work also gets a restart-safe request, and it is not a visible
 * Control UI turn, so it must stay quiet.
 */
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withSessionEntriesFromStoresInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { deriveSessionUnread } from "../../shared/session-unread.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createRestartSafeChatRequest,
  terminalizeRestartSafeChatAdmission,
} from "./chat-restart-recovery.js";

async function captureTerminalTarget(scope: {
  agentId: string;
  sessionKey: string;
  storePath: string;
}) {
  return withSessionEntriesFromStoresInWorker(
    [
      {
        ...scope,
        sessionKeys: [scope.sessionKey],
        projection: "exact",
      },
    ],
    ([read]) => {
      const source = read!.result.source;
      if (!source) {
        throw new Error("Expected an admitted physical session source");
      }
      return {
        target: {
          ...scope,
          readSource: source,
          target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
        },
        expectedLifecycleRevision: read!.result.entries[0]?.entry.lifecycleRevision,
        assertCurrent: vi.fn(),
      };
    },
    { ordered: true },
  );
}

it("counts a terminal restart-safe admission as unread activity", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
    };
    const sessionId = "restart-safe-unread-session";
    const runId = "restart-safe-unread-run";
    await upsertSessionEntryCore(scope, {
      sessionId,
      createdAt: 1_000,
      lastReadAt: 1_000,
      updatedAt: 1_000,
      startedAt: 1_000,
      lifecycleRevision: "restart-safe-unread-lifecycle",
      lifecycleRunId: runId,
      restartRecoveryDeliveryRunId: runId,
      restartRecoveryDeliverySourceRunId: runId,
    });
    expect(deriveSessionUnread(loadSessionEntry(scope))).toBe(false);

    const captured = await captureTerminalTarget(scope);
    expect(
      await terminalizeRestartSafeChatAdmission({
        ...captured,
        admittedSessionId: sessionId,
        clientRunId: runId,
        controlUiVisible: true,
        startedAt: 1_000,
        error: "Cloud worker unavailable",
        status: "failed",
        retryable: false,
      }),
    ).toBe(true);

    const entry = loadSessionEntry(scope);
    expect(entry).toMatchObject({ status: "failed" });
    expect(entry?.restartRecoveryDeliveryRunId).toBeUndefined();
    // The reply never reached the user, so the session must read as unread.
    expect(deriveSessionUnread(entry)).toBe(true);
  });
});

it("carries the browser visibility fact on a hidden Goal request", async () => {
  // A Goal request is admitted before the browser-client eligibility check, so
  // the request has to carry the visibility fact instead of the terminal write
  // assuming it from the admission's mere existence (see #155690).
  const request = await createRestartSafeChatRequest({
    cfg: {} as OpenClawConfig,
    controlUiVisible: false,
    eligible: false,
    goalRequestFingerprint: "goal-restart-safe-fingerprint",
    message: "internal objective",
    senderIsOwner: false,
  });
  expect(request).toEqual({
    controlUiVisible: false,
    fingerprint: "goal-restart-safe-fingerprint",
  });
});

it("keeps a hidden Goal admission quiet when it ends terminal", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
    };
    const sessionId = "hidden-goal-session";
    const runId = "hidden-goal-run";
    await upsertSessionEntryCore(scope, {
      sessionId,
      createdAt: 1_000,
      lastReadAt: 1_000,
      updatedAt: 1_000,
      startedAt: 1_000,
      lifecycleRevision: "hidden-goal-lifecycle",
      lifecycleRunId: runId,
      restartRecoveryDeliveryRunId: runId,
      restartRecoveryDeliverySourceRunId: runId,
    });

    const captured = await captureTerminalTarget(scope);
    expect(
      await terminalizeRestartSafeChatAdmission({
        ...captured,
        admittedSessionId: sessionId,
        clientRunId: runId,
        controlUiVisible: false,
        startedAt: 1_000,
        error: "Internal worker unavailable",
        status: "failed",
        retryable: false,
      }),
    ).toBe(true);

    const entry = loadSessionEntry(scope);
    // The failure is still recorded and the claim released...
    expect(entry).toMatchObject({ status: "failed" });
    expect(entry?.restartRecoveryDeliveryRunId).toBeUndefined();
    // ...but hidden work must not raise an unread marker the user never asked for.
    expect(deriveSessionUnread(entry)).toBe(false);
  });
});
