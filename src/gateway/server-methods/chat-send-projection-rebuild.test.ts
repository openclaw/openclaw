import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
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
import { runExclusiveSessionStoreWrite } from "../../config/sessions/store-writer.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { getActiveSessionWorkAdmissionCount } from "../../sessions/session-lifecycle-admission.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { handleGatewayRequest } from "../server-methods.js";
import { pendingChatSendDedupeKey } from "../server-shared.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
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
  await appendTranscriptMessage(fixture.scope, {
    eventId: "current-leaf",
    message: { role: "assistant", content: "Existing response.", timestamp: 2 },
  });
  fixture.params.expectedLeafEntryId = "current-leaf";
  const databaseOptions = toDatabaseOptions(resolveSqliteScope(fixture.scope));
  await waitForSessionTranscriptIndexReconcile(databaseOptions);
  const before = loadTranscriptEventsSync(fixture.scope);
  const beforeSession = loadSessionEntry(fixture.scope);
  const markRebuilding = () => {
    // Fault injection changes real projection state, not the reader or error classifier.
    openOpenClawAgentDatabase(databaseOptions)
      .db.prepare(
        "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
      )
      .run(fixture.scope.sessionId);
  };
  const assertNoDispatch = () => {
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    expect(fixture.context.chatAbortControllers.size).toBe(0);
    expect(fixture.context.chatQueuedTurns.size).toBe(0);
    expect(
      fixture.context.dedupe.has(pendingChatSendDedupeKey(fixture.params.idempotencyKey)),
    ).toBe(false);
    expect(listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
    expect(loadTranscriptEventsSync(fixture.scope)).toEqual(before);
    expect(getActiveSessionWorkAdmissionCount()).toBe(0);
  };
  const send = async () => {
    const respond = vi.fn<RespondFn>();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: fixture.params.idempotencyKey,
        method: "chat.send",
        params: fixture.params,
      },
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
    before,
    beforeSession,
    markRebuilding,
    assertNoDispatch,
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

describe("registered chat.send during SQLite projection rebuild", () => {
  it("rejects without mutation, then admits the same safe retry exactly once after reconciliation", async () => {
    const fixture = await createRebuildingFixture();
    try {
      fixture.markRebuilding();
      const rejected = await fixture.send();
      expectRebuildingResponse(rejected);
      fixture.assertNoDispatch();
      expect(loadSessionEntry(fixture.scope)).toEqual(fixture.beforeSession);
      await waitForSessionTranscriptIndexReconcile(fixture.databaseOptions);
      const accepted = await fixture.send();
      expect(accepted.mock.calls[0]?.[0]).toBe(true);
      expect(accepted.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
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
    } finally {
      await waitForSessionTranscriptIndexReconcile(fixture.databaseOptions);
      await fixture.cleanup();
    }
  });

  it.each(["active leaf", "settings"] as const)(
    "still rejects changed %s on the retry",
    async (change) => {
      const fixture = await createRebuildingFixture();
      try {
        fixture.params.expectedPermissionMode = null;
        fixture.markRebuilding();
        expectRebuildingResponse(await fixture.send());
        fixture.assertNoDispatch();
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
        fixture.assertNoDispatch();
      } finally {
        await waitForSessionTranscriptIndexReconcile(fixture.databaseOptions);
        await fixture.cleanup();
      }
    },
  );

  it.each(["expired", "removed", "lifecycle rotation", "chat abort"] as const)(
    "never revives a %s reservation while projection is rebuilding",
    async (change) => {
      const fixture = await createRebuildingFixture();
      const entered = createDeferred();
      const release = createDeferred();
      const writer = runExclusiveSessionStoreWrite(fixture.scope.storePath, async () => {
        entered.resolve();
        await release.promise;
      });
      let request: ReturnType<typeof fixture.send> | undefined;
      try {
        await entered.promise;
        fixture.markRebuilding();
        request = fixture.send();
        const key = pendingChatSendDedupeKey(fixture.params.idempotencyKey);
        await vi.waitFor(() => expect(fixture.context.dedupe.has(key)).toBe(true));
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
          const abortResponse = vi.fn<RespondFn>();
          await handleGatewayRequest({
            req: {
              type: "req",
              id: "cancel-pending",
              method: "chat.abort",
              params: {
                sessionKey: fixture.scope.sessionKey,
                runId: fixture.params.idempotencyKey,
              },
            },
            client: fixture.client,
            context: fixture.context,
            respond: abortResponse,
            isWebchatConnect: () => true,
          });
          expect(abortResponse.mock.calls[0]?.[1]).toMatchObject({ aborted: true });
        }
        release.resolve();
        await writer;
        const response = await request;
        expect(JSON.stringify(response.mock.calls)).not.toContain("cloud-session");
        fixture.assertNoDispatch();
        await waitForSessionTranscriptIndexReconcile(fixture.databaseOptions);
        expect(response.mock.calls[0]?.[1]).toMatchObject({
          status: "timeout",
          summary: "aborted",
        });
        const retry = await fixture.send();
        expect(retry.mock.calls[0]?.[1]).toMatchObject({ status: "timeout", summary: "aborted" });
        fixture.assertNoDispatch();
      } finally {
        release.resolve();
        await writer;
        await request;
        await waitForSessionTranscriptIndexReconcile(fixture.databaseOptions);
        await fixture.cleanup();
      }
    },
  );
});
