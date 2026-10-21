import { expect, test } from "vitest";
import type { QueuedCompactionHostOptions } from "../agents/embedded-agent-runner/compact.types.js";
import { withSessionCompactionPersistenceAsync } from "../agents/sessions/session-compaction-persistence.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../config/sessions.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { embeddedRunMock, rpcReq } from "./test-helpers.js";
import {
  seedLinearSessionTranscript,
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";
// Load after the fixture mocks, during collection rather than the first RPC deadline.
import "./server-methods/sessions-compact.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();
const initial = { compactionCount: 2, totalTokens: 120, totalTokensFresh: true };
const committed = { label: "Edited during summary", compactionCount: 4, totalTokens: 80 };

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
    const readEntry = () => loadSessionEntry({ ...scope, readConsistency: "latest" });
    await upsertSessionEntryCore(scope, sessionStoreEntry(scope.sessionId, initial));
    await seedLinearSessionTranscript({
      ...scope,
      contents: ["Retained first message", "Retained second message"],
    });
    embeddedRunMock.compactEmbeddedAgentSession.mockImplementationOnce(
      async (_params, hostInput) => {
        const host = hostInput as QueuedCompactionHostOptions;
        const manager = host.preparedSession?.sessionManager;
        const keptId = manager?.getEntries()[0]?.id;
        if (!manager || !keptId || !host.withCompactionPersistenceAsync) {
          throw new Error("expected prepared Gateway compaction persistence");
        }
        await upsertSessionEntryCore(scope, {
          ...readEntry(),
          sessionId: scope.sessionId,
          label: "Edited during summary",
          compactionCount: 3,
        });
        const boundary = ["summary", keptId, 120, undefined, undefined, undefined, 80] as const;
        await withSessionCompactionPersistenceAsync(
          manager,
          host.withCompactionPersistenceAsync,
          () => manager.appendCompactionAsync(...boundary),
        );
        expect(readEntry()).toMatchObject(committed);
        return {
          ok: true,
          compacted: true,
          compactionKind: "context-engine",
          result: { summary: "summary", firstKeptEntryId: keptId, tokensBefore: 120, tokensAfter },
        };
      },
    );

    const { ws } = await openClient();
    try {
      const response = await rpcReq(ws, "sessions.compact", { key: "main" });
      expect(response, JSON.stringify(response)).toMatchObject({
        ok: true,
        payload: { key: "agent:main:main", compacted: true },
      });
      const entry = readEntry();
      expect(entry).toMatchObject({
        ...committed,
        totalTokens: tokensAfter ?? 80,
        totalTokensFresh: tokensAfter !== undefined,
      });
      expect(entry?.totalTokensVersion).toBe(
        tokensAfter !== undefined ? SESSION_TOTAL_TOKENS_VERSION : undefined,
      );
      expect(await loadTranscriptEvents(scope)).toMatchObject([
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
