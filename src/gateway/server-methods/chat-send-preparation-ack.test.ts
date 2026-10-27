import { DatabaseSync } from "node:sqlite";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import {
  listSessionPendingInputs,
  loadSessionEntry,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { loadTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-read.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { historyLane } from "../../config/sessions/session-transcript-worker-resources.js";
import * as transcriptPersistence from "../../sessions/user-turn-transcript.persistence.js";
import * as skillSelection from "../../skills/library/selection.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { refusePendingInputCommit } from "../pending-input-commit.test-support.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import {
  setClientProfile,
  useBrowserFollowupFixture,
} from "./chat-send-pending-inputs.test-support.js";
import type { RespondFn } from "./types.js";

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createFixture = useBrowserFollowupFixture();
type Fixture = Awaited<ReturnType<typeof createFixture>>;

function expectStarted(fixture: Fixture, respond: ReturnType<typeof vi.fn<RespondFn>>) {
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
}

function expectUserTurn(
  fixture: Fixture,
  transcript: ReturnType<typeof loadTranscriptEventsSync> | undefined,
) {
  expect(transcript).toHaveLength(fixture.activeTranscript.length + 1);
  expect(transcript?.at(-1)).toMatchObject({
    message: {
      role: "user",
      content: fixture.params.message,
      idempotencyKey: `${fixture.params.idempotencyKey}:user`,
    },
  });
}

it("acknowledges staged chat input and joins its terminal disposition without host pending-input writes", async () => {
  const fixture = await createFixture();
  const runId = fixture.params.idempotencyKey;
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
    expect(await pendingAtAck).toMatchObject({ items: [{ state: "queued", runId }] });
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
    items: [{ state: "cancelled", runId }],
  });
});

it.for(["durable", "memory"] as const)(
  "acknowledges %s chat input while unrelated history cannot dispatch",
  async (storage, { signal }) => {
    const fixture = await createFixture({ active: false, storage });
    const runId = fixture.params.idempotencyKey;
    const profile = ensureProfileForEmail("history-independent-ack@example.test");
    setClientProfile(fixture.client, profile, "History contention fixture");
    const releaseHistory = createDeferred();
    const acknowledged = createDeferred();
    const runHistory = historyLane.pool.run.bind(historyLane.pool);
    const blockedHistory = vi.spyOn(historyLane.pool, "run").mockImplementation(async (...args) => {
      await releaseHistory.promise;
      return runHistory(...args);
    });
    const refuseRedundantStage =
      storage === "durable"
        ? refusePendingInputCommit({
            operation: "stage",
            message: "Idle input must commit directly with its restart claim",
            sessionId: fixture.scope.sessionId,
            runId,
          })
        : undefined;
    let entryAtAck: ReturnType<typeof loadSessionEntry>;
    let transcriptAtAck: ReturnType<typeof loadTranscriptEventsSync> | undefined;
    const respond = vi.fn<RespondFn>((ok) => {
      if (ok) {
        entryAtAck = loadSessionEntry(fixture.scope);
        transcriptAtAck = fixture.readTranscript();
      }
      acknowledged.resolve();
    });
    const sending = fixture.send(respond, {});
    try {
      await withinTest(acknowledged.promise, signal);
      expectStarted(fixture, respond);
      expect(entryAtAck).toMatchObject({
        sessionId: fixture.scope.sessionId,
        lifecycleRunId: runId,
        restartRecoveryDeliveryRunId: runId,
        restartRecoveryDeliverySourceRunId: runId,
        ...(storage === "memory" ? { incognito: true } : {}),
      });
      expectUserTurn(fixture, transcriptAtAck);
    } finally {
      releaseHistory.resolve();
      blockedHistory.mockRestore();
      refuseRedundantStage?.mockRestore();
      await sending;
      await fixture.cleanup();
    }
    expect(await listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
  },
);

it.each(["selected profile", "session access"] as const)(
  "rechecks %s before committing unhooked idle input",
  async (change) => {
    const fixture = await createFixture({ active: false });
    const runId = fixture.params.idempotencyKey;
    const source = ensureProfileForEmail("idle-admission-source@example.test");
    const other = ensureProfileForEmail("idle-admission-owner@example.test");
    setClientProfile(fixture.client, source);
    fixture.client.connect.scopes = ["operator.read", "operator.write"];
    await patchSessionEntryCore(fixture.scope, () => ({
      createdActor: { type: "human", source: "profile", id: other.id },
      visibility: "shared",
    }));
    const projection = await createSessionRowProjection({
      cfg: fixture.context.getRuntimeConfig(),
      modelCatalog: [],
    });
    bindSessionRowProjection(fixture.context, () => projection);
    const entered = createDeferred();
    const release = createDeferred();
    const persist = transcriptPersistence.persistUserTurnTranscript;
    const pausedCommit = vi
      .spyOn(transcriptPersistence, "persistUserTurnTranscript")
      .mockImplementation(async (params) => {
        entered.resolve();
        await release.promise;
        return persist(params);
      });
    const sending = fixture.send(undefined, { expectedProfileId: source.id });
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        sending,
        "Idle send settled before reaching its transcript owner",
      );
      expect(fixture.beforeApprove).not.toHaveBeenCalled();
      expect(await listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
      expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      if (change === "selected profile") {
        setClientProfile(fixture.client, other);
      } else if (change === "session access") {
        await patchSessionEntryCore(fixture.scope, () => ({ visibility: "draft" }));
      }
      release.resolve();
      const respond = await sending;
      expect(respond).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0]?.[0]).toBe(false);
      expect(respond.mock.calls[0]?.[2]).toBeDefined();
      expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
      expect(loadSessionEntry(fixture.scope)?.restartRecoveryDeliveryRunId).not.toBe(runId);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      expect(await listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
    } finally {
      release.resolve();
      await sending;
      pausedCommit.mockRestore();
      await fixture.cleanup();
      projection.dispose();
      await projection.ensureMaterialized();
    }
  },
);

it.for(["failure", "cancel"] as const)(
  "acknowledges durable input before skill session preparation (%s)",
  async (outcome, { signal }) => {
    await using fixture = await createFixture({ active: false });
    const runId = fixture.params.idempotencyKey;
    const profile = ensureProfileForEmail("preparation-ack@example.test");
    onTestFinished((await prepareUserProfileCatalog()).release);
    setClientProfile(fixture.client, profile, "Preparation fixture");
    const entered = createDeferred();
    const release = createDeferred();
    const prepare = skillSelection.prepareSkillLibrarySession;
    using _ = vi
      .spyOn(skillSelection, "prepareSkillLibrarySession")
      .mockImplementation(async (...args) => {
        entered.resolve();
        await release.promise;
        if (outcome === "failure") {
          throw new Error("Skill authoring preparation failed");
        }
        return prepare(...args);
      });
    using observer = new DatabaseSync(
      resolveSqliteTargetFromSessionStorePath(fixture.scope.storePath, { agentId: "main" }).path,
      { readOnly: true },
    );
    const readClaim = observer.prepare(
      `SELECT current_session_id AS sessionId, status,
        json_extract(entry_json, '$.lastInteractionAt') AS lastInteractionAt,
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
        userTurns: readUserTurn.all(fixture.scope.sessionId, `${runId}:user`),
      };
    });
    const acceptedAfter = Date.now();
    const sending = fixture.send(respond);
    try {
      await withinTest(entered.promise, signal);
      expectStarted(fixture, respond);
      expect(acknowledged).toEqual({
        claim: {
          sessionId: fixture.scope.sessionId,
          // #165733: admission clears the prior outcome; the run registry owns liveness.
          status: null,
          lastInteractionAt: expect.any(Number),
          lifecycleRunId: runId,
          runId,
          sourceRunId: runId,
        },
        userTurns: [
          {
            content: fixture.params.message,
            idempotencyKey: `${runId}:user`,
          },
        ],
      });
      expect(readClaim.get(fixture.scope.sessionKey)?.lastInteractionAt).toBeGreaterThanOrEqual(
        acceptedAfter,
      );
      const admittedTranscript = loadTranscriptEventsSync(fixture.scope);
      expectUserTurn(fixture, admittedTranscript);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();

      if (outcome === "cancel") {
        const params = { sessionKey: fixture.scope.sessionKey, runId };
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
          runIds: [runId],
        });
      }

      release.resolve();
      await sending;
      await fixture.finishDispatch();
      expect(respond).toHaveBeenCalledOnce();
      expect(loadTranscriptEventsSync(fixture.scope).slice(0, admittedTranscript.length)).toEqual(
        admittedTranscript,
      );
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      if (outcome === "failure") {
        expect(fixture.context.broadcast).toHaveBeenCalledWith(
          "chat",
          expect.objectContaining({
            runId,
            state: "error",
            errorMessage: expect.stringContaining("Skill authoring preparation failed"),
          }),
          expect.anything(),
        );
      }
    } finally {
      release.resolve();
      await sending;
    }
  },
);
