import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import {
  appendTranscriptMessage,
  listSessionPendingInputs,
  loadSessionEntry,
  loadTranscriptEventsSync,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { waitForSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { getSessionControllerWorkCount } from "../../sessions/session-controller.lifecycle.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { handleGatewayRequest } from "../server-methods.js";
import { pendingChatSendDedupeKey } from "../server-shared.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import {
  holdSessionWriter,
  observeChatReservation,
} from "./chat-send-admission-fixtures.test-support.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import type { RespondFn } from "./types.js";

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createBrowserFollowupFixture = useBrowserFollowupFixture();

async function createRebuildingFixture() {
  const fixture = await createBrowserFollowupFixture({
    active: false,
    persistDuringDispatch: true,
  });
  const runId = fixture.params.idempotencyKey;
  await appendTranscriptMessage(fixture.scope, {
    eventId: "current-leaf",
    message: { role: "assistant", content: "Existing response.", timestamp: 2 },
  });
  fixture.params.expectedLeafEntryId = "current-leaf";
  const databaseOptions = toDatabaseOptions(resolveSqliteScope(fixture.scope));
  await waitForSessionTranscriptIndexReconcile(databaseOptions);
  const before = loadTranscriptEventsSync(fixture.scope);
  // Fault injection changes real projection state, not the reader or error classifier.
  const markRebuilding = () =>
    openOpenClawAgentDatabase(databaseOptions)
      .db.prepare(
        "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
      )
      .run(fixture.scope.sessionId);
  const assertNoDispatch = async () => {
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    expect(rpcSourceTesting.size).toBe(0);
    expect(fixture.context.dedupe.has(pendingChatSendDedupeKey(runId))).toBe(false);
    expect(await listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
    expect(loadTranscriptEventsSync(fixture.scope)).toEqual(before);
    expect(getSessionControllerWorkCount()).toBe(0);
  };
  const send = async (method = "chat.send", params: unknown = fixture.params) => {
    const respond = vi.fn<RespondFn>();
    await handleGatewayRequest({
      req: { type: "req", id: runId, method, params },
      client: fixture.client,
      context: fixture.context,
      respond,
      isWebchatConnect: () => true,
    });
    return respond;
  };
  return {
    ...fixture,
    send,
    databaseOptions,
    beforeSession: loadSessionEntry(fixture.scope),
    markRebuilding,
    assertNoDispatch,
    async [Symbol.asyncDispose]() {
      await waitForSessionTranscriptIndexReconcile(databaseOptions);
      await fixture.cleanup();
    },
  };
}

function expectRebuildingResponse(respond: ReturnType<typeof vi.fn<RespondFn>>) {
  expect(respond).toHaveBeenCalledExactlyOnceWith(false, undefined, {
    code: "UNAVAILABLE",
    message: "session transcript is rebuilding; retry shortly",
    details: { method: "chat.send" },
    retryable: true,
    retryAfterMs: 250,
  });
  expect(JSON.stringify(respond.mock.calls)).not.toContain("cloud-session");
}

it("rejects without mutation, then admits the same safe retry exactly once after reconciliation", async () => {
  await using fixture = await createRebuildingFixture();
  fixture.markRebuilding();
  expectRebuildingResponse(await fixture.send());
  await fixture.assertNoDispatch();
  expect(loadSessionEntry(fixture.scope)).toEqual(fixture.beforeSession);
  await waitForSessionTranscriptIndexReconcile(fixture.databaseOptions);
  const accepted = await fixture.send();
  expect(accepted.mock.calls[0]).toMatchObject({ 0: true, 1: { status: "started" } });
  await fixture.finishDispatch();
  const after = loadTranscriptEventsSync(fixture.scope);
  expect(
    after.filter(
      (event) =>
        isRecord(event) &&
        event.type === "message" &&
        isRecord(event.message) &&
        event.message.role === "user",
    ),
  ).toHaveLength(2);
  const replay = await fixture.send();
  expect(replay.mock.calls[0]?.[0]).toBe(true);
  expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
  expect(loadTranscriptEventsSync(fixture.scope)).toEqual(after);
});

it.each(["active leaf", "settings"] as const)(
  "still rejects changed %s on the retry",
  async (change) => {
    await using fixture = await createRebuildingFixture();
    fixture.params.expectedPermissionMode = null;
    fixture.markRebuilding();
    expectRebuildingResponse(await fixture.send());
    await fixture.assertNoDispatch();
    await waitForSessionTranscriptIndexReconcile(fixture.databaseOptions);
    if (change === "active leaf") {
      fixture.params.expectedLeafEntryId = "obsolete-leaf";
    } else {
      await patchSessionEntryCore(fixture.scope, () => ({ permissionMode: "full" }));
    }
    const response = await fixture.send();
    expect(response.mock.calls[0]?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      details: {
        reason: change === "active leaf" ? "active-leaf-changed" : "session-settings-changed",
      },
    });
    await fixture.assertNoDispatch();
  },
);

it.for(["expired", "removed", "lifecycle rotation", "chat abort"] as const)(
  "never revives a %s reservation while projection is rebuilding",
  async (change, { signal }) => {
    await using fixture = await createRebuildingFixture();
    const runId = fixture.params.idempotencyKey;
    const writer = holdSessionWriter(fixture.scope.storePath);
    let request: ReturnType<typeof fixture.send> | undefined;
    try {
      await writer.entered;
      fixture.markRebuilding();
      let key: string;
      {
        using reservation = observeChatReservation(fixture.context, runId);
        key = reservation.key;
        request = fixture.send();
        await withinTest(reservation.wait(request), signal);
        expect(fixture.context.dedupe.has(key)).toBe(true);
      }
      if (change === "removed") {
        fixture.context.dedupe.delete(key);
      } else if (change === "expired") {
        const reservation = fixture.context.dedupe.get(key);
        if (!reservation || !isRecord(reservation.payload)) {
          throw new Error("Expected a live pending chat reservation");
        }
        fixture.context.dedupe.set(key, {
          ...reservation,
          payload: { ...reservation.payload, expiresAtMs: 1 },
        });
      } else if (change === "lifecycle rotation") {
        rotateAgentEventLifecycleGeneration();
      } else {
        const abortResponse = await fixture.send("chat.abort", {
          sessionKey: fixture.scope.sessionKey,
          runId,
        });
        expect(abortResponse.mock.calls[0]?.[1]).toMatchObject({ aborted: true });
      }
      writer.release();
      await writer.finished;
      const response = await request;
      expect(JSON.stringify(response.mock.calls)).not.toContain("cloud-session");
      await fixture.assertNoDispatch();
      await waitForSessionTranscriptIndexReconcile(fixture.databaseOptions);
      const aborted = { status: "timeout", summary: "aborted" };
      expect(response.mock.calls[0]?.[1]).toMatchObject(aborted);
      const retry = await fixture.send();
      expect(retry).toHaveBeenCalledExactlyOnceWith(
        true,
        expect.objectContaining(aborted),
        undefined,
        { cached: true },
      );
      fixture.params.message = "A different input must not reuse the aborted request.";
      expect(await fixture.send()).toHaveBeenCalledExactlyOnceWith(
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          details: { reason: "chat-request-conflict" },
        }),
      );
      await fixture.assertNoDispatch();
    } finally {
      writer.release();
      await writer.finished;
      await request;
    }
  },
);
