import { expect, test } from "vitest";
import type { QueuedCompactionHostOptions } from "../agents/embedded-agent-runner/compact.types.js";
import { withSessionCompactionPersistenceAsync } from "../agents/sessions/session-compaction-persistence.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../config/sessions.js";
import {
  loadSessionEntry as loadAccessorSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { embeddedRunMock, rpcReq } from "./test-helpers.js";
import {
  seedSessionTranscript,
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";
// Load after the fixture mocks, during collection rather than the first RPC deadline.
import "./server-methods/sessions-compact.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

function loadSessionEntry(scope: Parameters<typeof loadAccessorSessionEntry>[0]) {
  return loadAccessorSessionEntry({ ...scope, readConsistency: "latest" });
}

test.each([55, undefined])(
  "sessions.compact corrects a committed token estimate to %s without counting the boundary twice",
  async (tokensAfter) => {
    const { storePath } = await createSessionStoreDir();
    const scope = {
      agentId: "main",
      sessionId: "sess-compact-token-correction",
      sessionKey: "agent:main:main",
      storePath,
    };
    await upsertSessionEntryCore(
      scope,
      sessionStoreEntry(scope.sessionId, {
        compactionCount: 2,
        totalTokens: 120,
        totalTokensFresh: true,
      }),
    );
    await seedSessionTranscript({
      ...scope,
      messages: [
        { role: "user", content: "Retained first message" },
        { role: "user", content: "Retained second message" },
      ],
    });
    embeddedRunMock.compactEmbeddedAgentSession.mockImplementationOnce(
      async (_params, hostInput) => {
        const host = hostInput as QueuedCompactionHostOptions;
        const manager = host.preparedSession?.sessionManager;
        const firstKeptEntryId = manager?.getEntries()[0]?.id;
        if (!manager || !firstKeptEntryId || !host.withCompactionPersistenceAsync) {
          throw new Error("expected prepared Gateway compaction persistence");
        }
        await upsertSessionEntryCore(scope, {
          ...loadSessionEntry(scope),
          sessionId: scope.sessionId,
          label: "Edited during summary",
          compactionCount: 3,
        });
        await withSessionCompactionPersistenceAsync(
          manager,
          host.withCompactionPersistenceAsync,
          () =>
            manager.appendCompactionAsync(
              "summary",
              firstKeptEntryId,
              120,
              undefined,
              undefined,
              undefined,
              80,
            ),
        );
        expect(loadSessionEntry(scope)).toMatchObject({
          label: "Edited during summary",
          compactionCount: 4,
          totalTokens: 80,
        });
        return {
          ok: true,
          compacted: true,
          compactionKind: "context-engine",
          result: { summary: "summary", firstKeptEntryId, tokensBefore: 120, tokensAfter },
        };
      },
    );

    const { ws } = await openClient();
    try {
      const response = await rpcReq(ws, "sessions.compact", { key: "main" });
      expect(response.ok, JSON.stringify(response)).toBe(true);
      expect(response.payload).toMatchObject({ key: "agent:main:main", compacted: true });
      const entry = loadSessionEntry(scope);
      expect(entry).toMatchObject({ label: "Edited during summary", compactionCount: 4 });
      expect(entry?.totalTokens).toBe(tokensAfter ?? 80);
      expect(entry?.totalTokensFresh).toBe(tokensAfter !== undefined);
      expect(entry?.totalTokensVersion).toBe(
        tokensAfter !== undefined ? SESSION_TOTAL_TOKENS_VERSION : undefined,
      );
      const transcript = await loadTranscriptEvents(scope);
      expect(transcript).toMatchObject([
        { type: "session" },
        { type: "message", message: { content: "Retained first message" } },
        { type: "message", message: { content: "Retained second message" } },
        { type: "compaction" },
      ]);
    } finally {
      ws.close();
    }
  },
);
