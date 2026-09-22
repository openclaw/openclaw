import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as deltaEvents from "../../config/sessions/session-accessor.sqlite-history-events.js";
import type { SessionTranscriptDisplayDeltaResult } from "../../config/sessions/session-accessor.sqlite-history-query.js";
import type { SessionHistoryWorkerRequest } from "../../config/sessions/session-history-types.js";
import * as historyWorker from "../../config/sessions/session-history-worker-runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import type { RespondFn } from "./types.js";

it("keeps cursor response bytes while reading transcript events off the request thread", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:worker-delta",
      sessionId: "worker-delta",
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await appendTranscriptMessage(scope, {
      eventId: "question",
      now: 1,
      message: { role: "user", content: "Question", timestamp: 1 },
    });
    const context = await createHistoryReadContext();
    const call = async (cursor?: string) => {
      const respond = vi.fn<RespondFn>();
      await chatHistoryHandlers["chat.history"]!({
        params: { sessionKey: scope.sessionKey, ...(cursor ? { cursor } : {}) },
        client: null,
        context,
        respond,
        req: { type: "req", id: "worker-delta", method: "chat.history" },
        isWebchatConnect: () => false,
      });
      const response = expectDefined(respond.mock.calls[0], "history response");
      expect(response[0]).toBe(true);
      return expectDefined(asOptionalRecord(response[1]), "history payload");
    };
    const initial = await call();
    if (typeof initial.deltaCursor !== "string") {
      throw new Error("Expected initial delta cursor");
    }
    await appendTranscriptMessage(scope, {
      eventId: "answer",
      now: 2,
      message: { role: "assistant", content: 'Escaped "answer" 🤖', timestamp: 2 },
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      const deltaReader: {
        readSessionHistoryPageInWorker(
          request: Extract<SessionHistoryWorkerRequest, { kind: "delta" }>,
        ): Promise<SessionTranscriptDisplayDeltaResult>;
      } = historyWorker;
      const native = vi
        .spyOn(deltaReader, "readSessionHistoryPageInWorker")
        .mockImplementationOnce(async (request) =>
          deltaEvents.readTranscriptDisplayDelta(request.params.target, request.params.limits),
        );
      let golden: Record<string, unknown>;
      try {
        golden = await call(initial.deltaCursor);
      } finally {
        native.mockRestore();
      }
      expect(golden).toMatchObject({ kind: "delta", messages: [{ messageId: "answer" }] });
      const goldenJson = JSON.stringify(golden);
      const read = vi.spyOn(deltaEvents, "readTranscriptDisplayDelta").mockImplementation(() => {
        throw new Error("Transcript SQLite read ran on the request thread");
      });
      try {
        expect(JSON.stringify(await call(initial.deltaCursor))).toBe(goldenJson);
        expect(read).not.toHaveBeenCalled();
      } finally {
        read.mockRestore();
      }
    } finally {
      clock.mockRestore();
    }
  });
});
