import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  deleteSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { expectHistoryPayload, historyRpc } from "./chat-history-fixture.test-support.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { identifiedClient } from "./sessions-read-cache.test-support.js";

function expectWrongSession(respond: Awaited<ReturnType<ReturnType<typeof historyRpc>>>) {
  expect(respond).toHaveBeenCalledExactlyOnceWith(
    false,
    undefined,
    expect.objectContaining({
      code: "INVALID_REQUEST",
      message: "sessionId does not belong to sessionKey",
    }),
  );
}

describe("chat history stored ownership", () => {
  it.each(["retained", " global ", " unknown "])(
    "keeps the retained legacy-key reader available for %s",
    async (storedKey) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const cfg = {
          agents: { ownership: "explicit", entries: { research: {} } },
        } satisfies OpenClawConfig;
        await state.writeConfig(cfg);
        setRuntimeConfigSnapshot(cfg);
        const scope = {
          agentId: "research",
          sessionKey: `agent:research:${storedKey.trim()}`,
          sessionId: "retained-history",
        };
        await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
        const { messageId } = await appendTranscriptMessage(scope, {
          message: { role: "user", content: "Retained legacy history", timestamp: 1 },
        });
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
          expect(
            database
              .prepare(
                "UPDATE session_nodes SET session_key = ? WHERE session_key = ? AND entry_json = '{}'",
              )
              .run(storedKey, scope.sessionKey).changes,
          ).toBe(1);
          expect(
            database
              .prepare("UPDATE session_windows SET session_key = ? WHERE session_id = ?")
              .run(storedKey, scope.sessionId).changes,
          ).toBe(1);
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
        const respond = await request("chat.history", { ...scope, messageId }, { client });
        expectHistoryPayload(respond, {
          messages: [expect.objectContaining({ content: "Retained legacy history" })],
        });
      });
    },
  );

  it("keeps stored sentinel conversations separate from main and qualified keys in per-sender scope", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = {
        session: { scope: "per-sender" },
        agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      } satisfies OpenClawConfig;
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      for (const sentinel of ["global", "unknown"]) {
        await upsertSessionEntryCore(
          { agentId: "ops", sessionKey: sentinel },
          { sessionId: `${sentinel}-ops`, updatedAt: 1 },
        );
        const qualifiedKey = `agent:research:${sentinel}`;
        for (const [sessionKey, sessionId] of [
          [sentinel, `${sentinel}-research`],
          [qualifiedKey, `qualified-${sentinel}-research`],
        ] as const) {
          const scope = { agentId: "research", sessionKey };
          await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
          await appendTranscriptMessage(
            { ...scope, sessionId },
            {
              eventId: `${sessionId}-message`,
              message: { role: "user", content: `Message for ${sessionKey}`, timestamp: 1 },
            },
          );
        }
      }
      await upsertSessionEntryCore(
        { agentId: "research", sessionKey: "agent:research:main" },
        { sessionId: "main-research", updatedAt: 1 },
      );
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
      for (const sentinel of ["global", "unknown"]) {
        const qualifiedKey = `agent:research:${sentinel}`;
        for (const [sessionKey, wrongSessionKey, sessionId] of [
          [sentinel, qualifiedKey, `${sentinel}-research`],
          [qualifiedKey, sentinel, `qualified-${sentinel}-research`],
        ] as const) {
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
      }
    });
  });
});
