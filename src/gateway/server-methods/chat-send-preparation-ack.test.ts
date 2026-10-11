import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import {
  listSessionPendingInputs,
  loadSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { loadTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-read.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { historyLane } from "../../config/sessions/session-transcript-worker-resources.js";
import { getSessionWorkAdmissionRelease } from "../../sessions/session-lifecycle-admission.js";
import * as skillSelection from "../../skills/library/selection.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { refusePendingInputCommit } from "../pending-input-commit.test-support.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import type { RespondFn } from "./types.js";

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createFixture = useBrowserFollowupFixture();

it("acknowledges staged chat input and joins its terminal disposition without host pending-input writes", async () => {
  const fixture = await createFixture();
  let pendingAtAck: ReturnType<typeof listSessionPendingInputs> | undefined;
  const sql = observeHostDataSql();
  try {
    const ack = await fixture.send(
      vi.fn<RespondFn>((ok) => {
        if (ok) {
          pendingAtAck = listSessionPendingInputs(fixture.scope);
        }
      }),
    );
    expect(ack.mock.calls[0]?.[0]).toBe(true);
    expect(await pendingAtAck).toMatchObject({
      items: [{ state: "queued", runId: fixture.params.idempotencyKey }],
    });
    const recorder = await fixture.dispatchedRecorder;
    await recorder.completeProcessingAsync?.(
      buildAgentRunTerminalOutcome({ status: "error", stopReason: "rpc" }),
    );
    recorder.finishPendingInput?.("cancelled");
    expect(() => recorder.withPendingInput?.(() => {})).toThrow("ownership ended");
    await fixture.finishDispatch();
    const writes = sql.queries.filter((query) =>
      /\b(?:insert\s+into|update|delete\s+from)\s+["`]?session_(?:pending_inputs|input_completions)\b/i.test(
        query,
      ),
    );
    expect(writes).toEqual([]);
  } finally {
    sql.restore();
    await fixture.cleanup();
  }
  expect(await listSessionPendingInputs(fixture.scope)).toMatchObject({
    items: [{ state: "cancelled", runId: fixture.params.idempotencyKey }],
  });
});

it("retries a failed custody write with the same request identity without acknowledging lost input", async () => {
  const fixture = await createFixture();
  const refusal = refusePendingInputCommit({
    operation: "stage",
    message: "custody unavailable",
    sessionId: fixture.scope.sessionId,
    runId: fixture.params.idempotencyKey,
  });
  try {
    const rejected = await fixture.send();
    expect(rejected).toHaveBeenCalledWith(
      false,
      expect.objectContaining({ status: "error" }),
      expect.objectContaining({ message: expect.stringContaining("custody unavailable") }),
      expect.anything(),
    );
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
    expect(await listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
    expect(fixture.context.chatAbortControllers.has(fixture.params.idempotencyKey)).toBe(false);
    await getSessionWorkAdmissionRelease({
      scope: fixture.scope.storePath,
      identities: [fixture.scope.sessionKey, fixture.scope.sessionId],
    });

    refusal.mockRestore();
    const retried = await fixture.send();
    expect(retried).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ runId: fixture.params.idempotencyKey, status: "started" }),
      undefined,
      expect.anything(),
    );
    expect(await listSessionPendingInputs(fixture.scope)).toMatchObject({
      total: 1,
      items: [{ state: "queued", message: { content: fixture.approvedContent } }],
    });
    expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
  } finally {
    refusal.mockRestore();
    await fixture.cleanup();
  }
});

it.for(["durable", "native-incognito"] as const)(
  "acknowledges %s chat input while unrelated history cannot dispatch",
  async (storage, { signal }) => {
    const fixture = await createFixture({ active: false, storage });
    const profile = ensureProfileForEmail("history-independent-ack@example.test");
    fixture.client.authenticatedUserProfile = {
      profileId: profile.id,
      displayName: "History contention fixture",
      hasAvatar: false,
      updatedAt: profile.updatedAt,
    };
    const releaseHistory = createDeferred();
    const acknowledged = createDeferred();
    const runHistory = historyLane.pool.run.bind(historyLane.pool);
    const blockedHistory = vi.spyOn(historyLane.pool, "run").mockImplementation(async (...args) => {
      await releaseHistory.promise;
      return runHistory(...args);
    });
    let entryAtAck: ReturnType<typeof loadSessionEntry>;
    let transcriptAtAck: ReturnType<typeof loadTranscriptEventsSync> | undefined;
    const respond = vi.fn<RespondFn>((ok) => {
      if (ok) {
        entryAtAck = loadSessionEntry(fixture.scope);
        transcriptAtAck = loadTranscriptEventsSync(fixture.scope);
      }
      acknowledged.resolve();
    });
    const sending = fixture.send(respond, {});
    try {
      await withinTest(acknowledged.promise, signal);
      expect(respond).toHaveBeenCalledExactlyOnceWith(
        true,
        expect.objectContaining({
          runId: fixture.params.idempotencyKey,
          status: "started",
          messageSeq: 2,
        }),
        undefined,
        expect.anything(),
      );
      expect(entryAtAck).toMatchObject({
        sessionId: fixture.scope.sessionId,
        lifecycleRunId: fixture.params.idempotencyKey,
        restartRecoveryDeliveryRunId: fixture.params.idempotencyKey,
        restartRecoveryDeliverySourceRunId: fixture.params.idempotencyKey,
        ...(storage === "native-incognito" ? { incognito: true } : {}),
      });
      expect(transcriptAtAck).toHaveLength(fixture.activeTranscript.length + 1);
      expect(transcriptAtAck?.at(-1)).toMatchObject({
        message: {
          role: "user",
          content: fixture.params.message,
          idempotencyKey: `${fixture.params.idempotencyKey}:user`,
        },
      });
    } finally {
      releaseHistory.resolve();
      blockedHistory.mockRestore();
      await sending;
      await fixture.cleanup();
    }
  },
);

it.for(["dispatch", "failure", "cancel"] as const)(
  "acknowledges durable input before skill session preparation (%s)",
  async (outcome, { signal }) => {
    const fixture = await createFixture({ active: false });
    const profile = ensureProfileForEmail("preparation-ack@example.test");
    fixture.client.authenticatedUserProfile = {
      profileId: profile.id,
      displayName: "Preparation fixture",
      hasAvatar: false,
      updatedAt: profile.updatedAt,
    };
    const entered = createDeferred();
    const release = createDeferred();
    const waitForPreparation = async () => {
      entered.resolve();
      await release.promise;
      if (outcome === "failure") {
        throw new Error("Skill authoring preparation failed");
      }
    };
    const prepare = skillSelection.prepareSkillLibrarySession;
    const preparationSpy = vi
      .spyOn(skillSelection, "prepareSkillLibrarySession")
      .mockImplementation(async (...args) => {
        await waitForPreparation();
        return prepare(...args);
      });
    const observer = new DatabaseSync(
      resolveSqliteTargetFromSessionStorePath(fixture.scope.storePath, { agentId: "main" }).path,
      { readOnly: true },
    );
    const readClaim = observer.prepare(
      `SELECT current_session_id AS sessionId, status,
        json_extract(entry_json, '$.lifecycleRunId') AS lifecycleRunId,
        json_extract(entry_json, '$.restartRecoveryDeliveryRunId') AS runId,
        json_extract(entry_json, '$.restartRecoveryDeliverySourceRunId') AS sourceRunId
       FROM session_nodes WHERE session_key = ?`,
    );
    const readUserTurn = observer.prepare(
      `SELECT json_extract(event_json, '$.message.content') AS content,
        json_extract(event_json, '$.message.idempotencyKey') AS idempotencyKey
       FROM transcript_events WHERE session_id = ?
       AND json_extract(event_json, '$.type') = 'message'
       AND json_extract(event_json, '$.message.role') = 'user'
       AND json_extract(event_json, '$.message.idempotencyKey') = ?`,
    );
    let acknowledged: { claim: unknown; userTurns: unknown[] } | undefined;
    const respond = vi.fn<RespondFn>(() => {
      // Observe committed state at ACK emission, before any response-delivery await.
      acknowledged = {
        claim: readClaim.get(fixture.scope.sessionKey),
        userTurns: readUserTurn.all(
          fixture.scope.sessionId,
          `${fixture.params.idempotencyKey}:user`,
        ),
      };
    });
    const sending = fixture.send(respond);
    try {
      await withinTest(entered.promise, signal);
      expect(respond).toHaveBeenCalledExactlyOnceWith(
        true,
        expect.objectContaining({
          runId: fixture.params.idempotencyKey,
          status: "started",
          messageSeq: 2,
        }),
        undefined,
        expect.anything(),
      );
      expect(acknowledged).toEqual({
        claim: {
          sessionId: fixture.scope.sessionId,
          // #165733: admission clears the prior outcome; the run registry owns liveness.
          status: null,
          lifecycleRunId: fixture.params.idempotencyKey,
          runId: fixture.params.idempotencyKey,
          sourceRunId: fixture.params.idempotencyKey,
        },
        userTurns: [
          {
            content: fixture.params.message,
            idempotencyKey: `${fixture.params.idempotencyKey}:user`,
          },
        ],
      });
      const admittedTranscript = loadTranscriptEventsSync(fixture.scope);
      expect(admittedTranscript).toHaveLength(fixture.activeTranscript.length + 1);
      expect(admittedTranscript.at(-1)).toMatchObject({
        message: {
          role: "user",
          content: fixture.params.message,
          idempotencyKey: `${fixture.params.idempotencyKey}:user`,
        },
      });
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();

      if (outcome === "cancel") {
        const params = {
          sessionKey: fixture.scope.sessionKey,
          runId: fixture.params.idempotencyKey,
        };
        const abortResponse = vi.fn<RespondFn>();
        await handleChatAbortRequest({
          params,
          req: { type: "req", id: "cancel-preparation", method: "chat.abort", params },
          client: fixture.client,
          context: fixture.context,
          respond: abortResponse,
          isWebchatConnect: () => true,
        });
        expect(abortResponse).toHaveBeenCalledWith(true, {
          ok: true,
          aborted: true,
          runIds: [fixture.params.idempotencyKey],
        });
      }

      release.resolve();
      await sending;
      if (outcome === "dispatch") {
        await withinTest(fixture.dispatchedRecorder, signal);
        expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
        const dispatch = dispatchInboundMessageMock.mock.calls[0]?.[0] as Parameters<
          typeof dispatchInboundMessage
        >[0];
        expect(dispatch.ctx).toMatchObject({
          Body: fixture.params.message,
          MessageSid: fixture.params.idempotencyKey,
        });
        expect(dispatch.replyOptions?.skillLibraryAuthoring).toMatchObject({ target: "personal" });
      }
      await fixture.finishDispatch();
      expect(respond).toHaveBeenCalledOnce();
      expect(loadTranscriptEventsSync(fixture.scope).slice(0, admittedTranscript.length)).toEqual(
        admittedTranscript,
      );
      if (outcome !== "dispatch") {
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      }
      if (outcome === "failure") {
        expect(fixture.context.broadcast).toHaveBeenCalledWith(
          "chat",
          expect.objectContaining({
            runId: fixture.params.idempotencyKey,
            state: "error",
            errorMessage: expect.stringContaining("Skill authoring preparation failed"),
          }),
          expect.anything(),
        );
      }
    } finally {
      release.resolve();
      try {
        await sending;
      } finally {
        observer.close();
        preparationSpy.mockRestore();
        await fixture.cleanup();
      }
    }
  },
);
