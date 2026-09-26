import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  replaceSessionEntrySync,
  replaceTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as storeSources from "../session-utils-store-sources.js";
import { sessionByKeyReadHandlers } from "./sessions-read-by-key.js";
import {
  identifiedClient,
  initializeSessionReadContext,
  requestContext,
} from "./sessions-read-cache.test-support.js";

it("keeps warm, dirty, and archived keyed RPCs off host SQLite while preserving raw messages", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:raw-worker-history",
      sessionId: "raw-worker-history",
    };
    replaceSessionEntrySync(scope, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      visibility: "shared",
    });
    const messages = [
      { role: "user", content: "Earlier message" },
      { role: "assistant", channel: "commentary", content: "Checking the fixture" },
      { role: "toolResult", toolCallId: "synthetic-call", content: "Synthetic tool output" },
      { role: "assistant", content: "Final answer" },
    ];
    await replaceTranscriptEvents(scope, [
      { type: "session", id: scope.sessionId },
      ...messages.map((message, index) => ({
        type: "message",
        id: `message-${index}`,
        parentId: index === 0 ? null : `message-${index - 1}`,
        message,
      })),
    ]);
    const context = requestContext({ agents: { entries: { main: {} } } });
    const client = identifiedClient("synthetic-viewer");
    await initializeSessionReadContext(context);
    const read = async (method: "sessions.get" | "sessions.describe" = "sessions.get") => {
      const respond = vi.fn();
      await sessionByKeyReadHandlers[method]!({
        req: { type: "req", id: "raw-worker-history", method },
        params: { key: scope.sessionKey, ...(method === "sessions.get" ? { limit: 3 } : {}) },
        client,
        context,
        respond,
        isWebchatConnect: () => false,
      });
      expect(respond).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      return respond.mock.calls[0]?.[1];
    };
    const expected = await read();
    expect(expected).toMatchObject({ messages: messages.slice(1) });
    expect(expected).toMatchObject({
      messages: [
        { __openclaw: { id: "message-1" } },
        { __openclaw: { id: "message-2" } },
        { __openclaw: { id: "message-3" } },
      ],
    });
    const hostSql = observeHostDataSql();
    const prepareSources = vi.spyOn(storeSources, "prepareGatewaySessionStoreReadSources");
    try {
      for (let index = 0; index < 100; index++) {
        expect(await read()).toEqual(expected);
      }
      expect(hostSql.calls.flatMap((call) => call.mock.calls)).toEqual([]);
      expect(prepareSources).not.toHaveBeenCalled();
      for (const method of ["sessions.get", "sessions.describe"] as const) {
        for (let index = 0; index < 100; index++) {
          sessionChanges.emit({ agentId: scope.agentId, sessionKey: scope.sessionKey });
          // Count the RPC read, independently of the committed writer's publication work.
          hostSql.calls.forEach((call) => call.mockClear());
          const result = await read(method);
          if (method === "sessions.get") {
            expect(result).toEqual(expected);
          } else {
            expect(result).toMatchObject({ session: { sessionId: scope.sessionId } });
          }
          expect(hostSql.calls.flatMap((call) => call.mock.calls)).toEqual([]);
          expect(prepareSources).not.toHaveBeenCalled();
        }
      }
      replaceSessionEntrySync(scope, {
        sessionId: scope.sessionId,
        updatedAt: 1,
        visibility: "shared",
        archivedAt: 1,
      });
      for (const method of ["sessions.get", "sessions.describe"] as const) {
        sessionChanges.emit({ all: true, scope: "catalog" });
        hostSql.calls.forEach((call) => call.mockClear());
        const result = await read(method);
        if (method === "sessions.get") {
          expect(result).toEqual(expected);
        } else {
          expect(result).toMatchObject({ session: { sessionId: scope.sessionId, archivedAt: 1 } });
        }
        expect(hostSql.calls.flatMap((call) => call.mock.calls)).toEqual([]);
        expect(prepareSources).not.toHaveBeenCalled();
      }
    } finally {
      prepareSources.mockRestore();
      hostSql.restore();
    }
  });
});
