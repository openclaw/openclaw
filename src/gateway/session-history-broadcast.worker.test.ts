import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  replaceSessionEntry,
  replaceTranscriptEvents,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.js";
import * as projection from "../config/sessions/session-accessor.sqlite-active-projection.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createHandler,
  loadAccessorSessionEntryReadOnlyMock,
  loadGatewaySessionRowMock,
  readSessionMessageByIdAsyncMock,
  readSessionMessageCountAsyncMock,
  runtimeConfigState,
  sessionRow,
} from "./server-session-events.test-support.js";

afterEach(() => vi.restoreAllMocks());

it.each(["by-id", "count"] as const)(
  "keeps the event loop available while broadcasting a stored %s read",
  async (kind) => {
    const readers = await vi.importActual<typeof import("./session-transcript-readers.js")>(
      "./session-transcript-readers.js",
    );
    readSessionMessageByIdAsyncMock.mockImplementation(readers.readSessionMessageByIdAsync);
    readSessionMessageCountAsyncMock.mockImplementation(readers.readSessionMessageCountAsync);
    runtimeConfigState.value = {};
    loadGatewaySessionRowMock.mockReturnValue(sessionRow);
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const target = {
        agentId: "main",
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
        storePath: state.statePath("broadcast.sqlite"),
      };
      const entry = { sessionId: target.sessionId, updatedAt: 1 };
      await replaceSessionEntry(target, entry);
      await replaceTranscriptEvents(target, [
        { type: "session", version: 3, id: target.sessionId },
        {
          type: "message",
          id: "question",
          parentId: null,
          message: { role: "user", content: "Stored question" },
        },
        {
          type: "message",
          id: "answer",
          parentId: "question",
          message: { role: "assistant", content: "Stored answer" },
        },
      ]);
      await waitForSessionTranscriptProjection(target);
      loadAccessorSessionEntryReadOnlyMock.mockReturnValue(entry);
      const snapshot = vi.spyOn(projection, "withCurrentProjectionSnapshot");
      const { handler, broadcastToConnIds } = createHandler(false);
      let eventLoopProgress = false;
      const turn = setImmediate().then(() => {
        eventLoopProgress = true;
      });
      let progressedBeforeDelivery = false;
      broadcastToConnIds.mockImplementation(() => {
        progressedBeforeDelivery = eventLoopProgress;
      });
      try {
        await handler({
          target,
          ...(kind === "by-id" ? { messageId: "answer" } : {}),
          message: { role: "assistant", content: "Queued answer" },
        });
        expect(broadcastToConnIds).toHaveBeenCalledWith(
          "session.message",
          expect.objectContaining({
            messageSeq: 2,
            message: expect.objectContaining({
              content: kind === "by-id" ? "Stored answer" : "Queued answer",
            }),
          }),
          expect.any(Set),
        );
        expect(progressedBeforeDelivery).toBe(true);
        expect(snapshot).not.toHaveBeenCalled();
      } finally {
        await turn;
        snapshot.mockRestore();
      }
    });
  },
);
