import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import * as diagnostics from "../../infra/diagnostics-timeline.js";
import { readUserTurnRequesterOrigin } from "../../sessions/user-turn-transcript-admission.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  expectHistorySuccess,
  requestHistory,
  seedHistorySession,
} from "./chat-history-fixtures.test-support.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { identifiedClient } from "./sessions-read-cache.test-support.js";
import type { GatewayRequestContext } from "./types.js";

afterEach(() => vi.restoreAllMocks());

it.each(["chat.history", "chat.startup"] as const)(
  "%s keeps redacted requester identity out of the serialized display response",
  async (method) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const scope = await seedHistorySession("requester-redaction");
      const requesterOrigin = {
        sessionKey: "agent:main:telegram:group:PRIVATE_SOURCE",
        messageProvider: "telegram",
        accountId: "private_account",
        conversationId: "PRIVATE_CONVERSATION",
        senderId: "PRIVATE_SENDER",
        senderName: "PRIVATE_NAME",
      };
      const redacted = { senderId: "redacted", senderName: "Anonymous" };
      const recorder = createUserTurnTranscriptRecorder({
        input: {
          text: "Visible request",
          idempotencyKey: "redacted-request:user",
          requesterOrigin,
          sender: { id: requesterOrigin.senderId, name: requesterOrigin.senderName },
        },
        target: { ...scope, sessionEntry: undefined },
        beforeMessageWrite: ({ message }) => ({ ...message, __openclaw: redacted }),
      });
      try {
        expect(
          await recorder.stageApproved!({ runId: "redacted-request", assertCurrent: () => {} }),
        ).toBe(true);
        const persisted = await recorder.persistApproved();
        expect(persisted?.message["__openclaw"]).toMatchObject({ ...redacted, requesterOrigin });
        expect(readUserTurnRequesterOrigin(recorder)).toMatchObject(requesterOrigin);

        const params = { sessionKey: scope.sessionKey };
        const response = expectHistorySuccess(
          await requestHistory(method, params, await createHistoryReadContext()),
        );
        expect(response.sessionId).toBe(scope.sessionId);
        const serialized = JSON.stringify(response);
        expect(serialized).toContain("Visible request");
        expect(serialized).toContain('"senderId":"redacted"');
        expect(serialized).toContain('"senderName":"Anonymous"');
        expect(serialized).not.toContain("PRIVATE_");
        expect(serialized).not.toContain("requesterOrigin");
        expect(readUserTurnRequesterOrigin(recorder)).toMatchObject(requesterOrigin);
        expect(persisted?.message["__openclaw"]?.requesterOrigin).toMatchObject(requesterOrigin);
      } finally {
        recorder.finishPendingInput?.("interrupted");
        await recorder.waitForPendingInputSettlement?.();
      }
    });
  },
);

it("reads prepared history catalogs without querying the unused requester identity", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const profile = ensureProfileForEmail("history@example.test");
    const scope = { agentId: "main", sessionKey: "agent:main:requester-history" };
    await upsertSessionEntryCore(scope, { sessionId: "requester-history", updatedAt: 1 });
    const client = identifiedClient(profile.id);
    client.connect.scopes = ["operator.admin"];
    const readChatStartupProjection = vi.fn<
      NonNullable<GatewayRequestContext["readChatStartupProjection"]>
    >(async () => undefined);
    const context = await createHistoryReadContext({ readChatStartupProjection });
    const measuredStatements: number[] = [];
    const measure = diagnostics.measureDiagnosticsTimelineSpan;
    vi.spyOn(diagnostics, "measureDiagnosticsTimelineSpan").mockImplementation(
      (name, run, options) => {
        if (!name.endsWith(".startup_projection")) {
          return measure(name, run, options);
        }
        const sql = observeHostDataSql();
        try {
          const result = measure(name, run, options);
          measuredStatements.push(sql.queries.length);
          return result;
        } finally {
          sql.restore();
        }
      },
    );
    const response = expectHistorySuccess(
      await requestHistory("chat.history", scope, context, client),
    );
    expect(response.sessionId).toBe("requester-history");
    expect(measuredStatements).toEqual([0]);
    expect(readChatStartupProjection).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ readPolicy: "ready" }),
    );
    expect(readChatStartupProjection.mock.calls[0]?.[0]).not.toHaveProperty(
      "readRequesterProfileId",
    );
  });
});
