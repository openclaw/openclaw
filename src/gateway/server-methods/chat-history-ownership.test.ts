import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  deleteSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import {
  expectHistoryError,
  expectHistoryPayload,
  historyRpc,
  withHistoryState,
} from "./chat-history-fixture.test-support.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { identifiedClient } from "./sessions-read-cache.test-support.js";

function expectWrongSession(respond: Awaited<ReturnType<ReturnType<typeof historyRpc>>>) {
  expectHistoryError(respond, {
    code: "INVALID_REQUEST",
    message: "sessionId does not belong to sessionKey",
  });
}

async function seed(agentId: string, sessionKey: string, sessionId: string, content?: string) {
  const scope = { agentId, sessionKey, sessionId };
  await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
  if (content) {
    await appendTranscriptMessage(scope, {
      eventId: `${sessionId}-message`,
      message: { role: "user", content, timestamp: 1 },
    });
  }
  return scope;
}
it.each(["retained", " global ", " unknown "])(
  "keeps the retained legacy-key reader available for %s",
  async (storedKey) => {
    await withHistoryState(async (state) => {
      const cfg = {
        agents: { ownership: "explicit", entries: { research: {} } },
      } satisfies OpenClawConfig;
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const scope = await seed(
        "research",
        `agent:research:${storedKey.trim()}`,
        "retained-history",
        "Retained legacy history",
      );
      const messageId = `${scope.sessionId}-message`;
      await deleteSessionEntryLifecycle({
        agentId: scope.agentId,
        storePath: resolveSessionStorePathCore(undefined, { agentId: scope.agentId }),
        target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
        archiveTranscript: false,
      });
      await closeOpenClawAgentDatabasesAsync();
      const database = new DatabaseSync(
        path.join(state.agentDir("research"), "openclaw-agent.sqlite"),
      );
      try {
        database.exec("PRAGMA foreign_keys = ON; BEGIN; PRAGMA defer_foreign_keys = ON");
        const nodes = database.prepare(
          "UPDATE session_nodes SET session_key = ? WHERE session_key = ? AND entry_json = '{}'",
        );
        const windows = database.prepare(
          "UPDATE session_windows SET session_key = ? WHERE session_id = ?",
        );
        expect([
          nodes.run(storedKey, scope.sessionKey).changes,
          windows.run(storedKey, scope.sessionId).changes,
        ]).toEqual([1, 1]);
        database
          .prepare("UPDATE session_nodes SET entry_valid = -1 WHERE session_key = ?")
          .run(storedKey);
        database.exec("COMMIT");
      } finally {
        database.close();
      }
      const client = identifiedClient("retained-history-operator");
      client.connect.scopes = ["operator.admin"];
      const request = historyRpc(
        await createHistoryReadContext({ getRuntimeConfig: () => cfg }),
        scope.sessionKey,
      );
      expectHistoryPayload(await request("chat.history", { ...scope, messageId }, { client }), {
        messages: [expect.objectContaining({ content: "Retained legacy history" })],
      });
    });
  },
);

it("keeps stored sentinel conversations separate from main and qualified keys in per-sender scope", async () => {
  await withHistoryState(async (state) => {
    const cfg = {
      session: { scope: "per-sender" },
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    } satisfies OpenClawConfig;
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const rows = ["global", "unknown"].flatMap((sentinel) => [
      [sentinel, `agent:research:${sentinel}`, `${sentinel}-research`] as const,
      [`agent:research:${sentinel}`, sentinel, `qualified-${sentinel}-research`] as const,
    ]);
    for (const sentinel of ["global", "unknown"]) {
      await seed("ops", sentinel, `${sentinel}-ops`);
    }
    for (const [sessionKey, , sessionId] of rows) {
      await seed("research", sessionKey, sessionId, `Message for ${sessionKey}`);
    }
    await seed("research", "agent:research:main", "main-research");
    const context = await createHistoryReadContext({ getRuntimeConfig: () => cfg });
    const client = identifiedClient("literal-global-operator");
    client.connect.scopes = ["operator.admin"];
    const request = historyRpc(context, "global");
    const read = (params: Record<string, unknown>) =>
      request("chat.history", { ...params, agentId: "research" }, { client });
    for (const [sessionKey, sessionId] of [
      ["global", "global-research"],
      ["agent:research:main", "main-research"],
    ] as const) {
      expectHistoryPayload(await read({ sessionKey }), { sessionKey, sessionId });
    }
    expectWrongSession(
      await read({
        sessionKey: "global",
        sessionId: "missing-session",
        messageId: "missing-message",
      }),
    );
    for (const [sessionKey, wrongSessionKey, sessionId] of rows) {
      const messageId = `${sessionId}-message`;
      expectWrongSession(await read({ sessionKey: wrongSessionKey, sessionId, messageId }));
      expectHistoryPayload(await read({ sessionKey, sessionId, messageId }), {
        sessionKey,
        sessionId,
        messages: [
          expect.objectContaining({
            __openclaw: expect.objectContaining({ id: messageId }),
            content: `Message for ${sessionKey}`,
          }),
        ],
      });
    }
  });
});
