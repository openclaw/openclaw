import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  deleteSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { identifiedClient } from "./sessions-read-cache.test-support.js";
import type { RespondFn } from "./types.js";

describe("chat history stored ownership", () => {
  it.each(["retained", " global ", " unknown "])(
    "keeps the retained legacy-key reader available for %s",
    async (storedKey) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const cfg = {
          agents: { ownership: "explicit", entries: { research: {} } },
        } satisfies OpenClawConfig;
        await state.writeConfig(cfg);
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
        const respond = vi.fn<RespondFn>();
        await expectDefined(
          chatHistoryHandlers["chat.history"],
          "history handler",
        )({
          params: { ...scope, messageId },
          context: await createHistoryReadContext({ getRuntimeConfig: () => cfg }),
          client,
          respond,
          req: { type: "req", id: "retained-history", method: "chat.history" },
          isWebchatConnect: () => false,
        });
        expect(respond).toHaveBeenCalledExactlyOnceWith(
          true,
          expect.objectContaining({
            messages: [expect.objectContaining({ content: "Retained legacy history" })],
          }),
        );
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
      const read = async (params: {
        sessionKey: string;
        sessionId?: string;
        messageId?: string;
      }) => {
        const respond = vi.fn<RespondFn>();
        await expectDefined(
          chatHistoryHandlers["chat.history"],
          "history handler",
        )({
          params: { ...params, agentId: "research" },
          context,
          req: { type: "req", id: "literal-global", method: "chat.history" },
          client,
          isWebchatConnect: () => false,
          respond,
        });
        return respond;
      };
      for (const [sessionKey, sessionId] of [
        ["global", "global-research"],
        ["agent:research:main", "main-research"],
      ] as const) {
        expect(await read({ sessionKey })).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ sessionKey, sessionId }),
        );
      }
      expect(
        await read({
          sessionKey: "global",
          sessionId: "missing-session",
          messageId: "missing-message",
        }),
      ).toHaveBeenCalledExactlyOnceWith(
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          message: "sessionId does not belong to sessionKey",
        }),
      );
      for (const sentinel of ["global", "unknown"]) {
        const qualifiedKey = `agent:research:${sentinel}`;
        for (const [sessionKey, wrongSessionKey, sessionId] of [
          [sentinel, qualifiedKey, `${sentinel}-research`],
          [qualifiedKey, sentinel, `qualified-${sentinel}-research`],
        ] as const) {
          const messageId = `${sessionId}-message`;
          expect(
            await read({ sessionKey: wrongSessionKey, sessionId, messageId }),
          ).toHaveBeenCalledExactlyOnceWith(
            false,
            undefined,
            expect.objectContaining({
              code: "INVALID_REQUEST",
              message: "sessionId does not belong to sessionKey",
            }),
          );
          expect(await read({ sessionKey, sessionId, messageId })).toHaveBeenCalledExactlyOnceWith(
            true,
            expect.objectContaining({
              sessionKey,
              sessionId,
              messages: [
                expect.objectContaining({
                  __openclaw: expect.objectContaining({ id: messageId }),
                  content: `Message for ${sessionKey}`,
                }),
              ],
            }),
          );
        }
      }
    });
  });
});
