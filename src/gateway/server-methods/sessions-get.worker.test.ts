import { expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { sessionReader } from "./sessions-keyed-read.test-support.js";
import {
  identifiedClient,
  initializeSessionReadContext,
  requestContext,
} from "./sessions-read-cache.test-support.js";

it("keeps warm, dirty, and archived keyed RPCs off host SQLite while preserving raw messages", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:raw-worker-history",
      sessionId: "raw-worker-history",
    };
    const entry = {
      sessionId: scope.sessionId,
      updatedAt: 1,
      visibility: "shared" as const,
    };
    replaceSessionEntrySync(scope, entry);
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
    const context = requestContext(cfg);
    const client = identifiedClient("synthetic-viewer");
    await initializeSessionReadContext(context);
    const reader = sessionReader(context, client, scope.sessionKey);
    const read = (method: "sessions.get" | "sessions.describe" = "sessions.get") =>
      reader(method, method === "sessions.get" ? 3 : undefined);
    const expected = await read();
    expect(expected).toMatchObject({
      messages: messages
        .slice(1)
        .map((message, index) =>
          Object.assign({}, message, { __openclaw: { id: `message-${index + 1}` } }),
        ),
    });
    const hostSql = observeHostDataSql();
    const assertWorkerRead = async (
      method: "sessions.get" | "sessions.describe",
      archived = false,
    ) => {
      // Count the RPC read, independently of the committed writer's publication work.
      hostSql.calls.forEach((call) => call.mockClear());
      const result = await read(method);
      if (method === "sessions.get") {
        expect(result).toEqual(expected);
      } else {
        expect(result).toMatchObject({
          session: { sessionId: scope.sessionId, ...(archived ? { archivedAt: 1 } : {}) },
        });
      }
      expect(hostSql.calls.flatMap((call) => call.mock.calls)).toEqual([]);
    };
    try {
      for (let index = 0; index < 2; index++) {
        expect(await read()).toEqual(expected);
      }
      expect(hostSql.calls.flatMap((call) => call.mock.calls)).toEqual([]);
      for (const method of ["sessions.get", "sessions.describe"] as const) {
        for (let index = 0; index < 2; index++) {
          sessionChanges.emit({ agentId: scope.agentId, sessionKey: scope.sessionKey });
          await assertWorkerRead(method);
        }
      }
      replaceSessionEntrySync(scope, { ...entry, archivedAt: 1 });
      for (const method of ["sessions.get", "sessions.describe"] as const) {
        sessionChanges.emit({ all: true, scope: "catalog" });
        await assertWorkerRead(method, true);
      }
    } finally {
      hostSql.restore();
    }
  });
});
