import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assert, expect, it, vi } from "vitest";
import { captureRuntimeConfigAsyncReader } from "../../config/config.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  deleteSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as historyWorker from "../../config/sessions/session-history-worker-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import {
  expectHistoryError,
  expectHistoryPayload,
  historyRpc,
  historyPayload,
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

it("refuses continuity into a retained physical session while preserving ordinary historical reads", async () => {
  await withHistoryState(async () => {
    await captureRuntimeConfigAsyncReader()();
    const key = "agent:main:physical-continuity";
    await seed("main", key, "physical-old", "retained old history");
    const before = historyPayload(
      await historyRpc(await createHistoryReadContext(), key)("chat.history"),
    );
    assert(typeof before.deltaCursor === "string");
    assert(typeof before.sessionInfo === "object" && before.sessionInfo !== null);
    const leaf = Reflect.get(before.sessionInfo, "activeLeafEntryId");
    assert(typeof leaf === "string");

    await seed("main", key, "physical-new", "new selected history");
    const request = historyRpc(await createHistoryReadContext(), key);
    const selector = { sessionId: "physical-old", messageId: "physical-old-message" };
    expectHistoryPayload(await request("chat.history", selector), {
      messages: [expect.objectContaining({ content: "retained old history" })],
    });
    expectHistoryError(
      await request("chat.history", {
        ...selector,
        continuity: { cursor: before.deltaCursor, activeLeafEntryId: leaf },
      }),
      {
        code: "UNAVAILABLE",
        message: "session changed while reading history; reload the conversation",
      },
    );
  });
});

it.each([false, true])(
  "preserves displayable oversized anchors through continuity (incognito: %s)",
  async (incognito) => {
    await withHistoryState(async () => {
      await captureRuntimeConfigAsyncReader()();
      const scope = {
        agentId: "main",
        sessionKey: incognito
          ? "agent:main:dashboard:incognito-oversized-continuity"
          : "agent:main:dashboard:oversized-continuity",
        sessionId: `oversized-current-${incognito}`,
      };
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: 1,
        incognito: incognito ? true : undefined,
      });
      const maxBytes = 256 * 1024;
      for (const [eventId, role, content] of [
        ["preceding", "assistant", "preceding answer"],
        ["anchor", "user", "large source ".repeat(30_000)],
      ] as const) {
        await appendTranscriptMessage(scope, { eventId, message: { role, content } });
      }
      const request = historyRpc(await createHistoryReadContext(), scope.sessionKey);
      const before = historyPayload(await request("chat.history"));
      assert(typeof before.deltaCursor === "string");
      expect(before.sessionInfo).toMatchObject({ activeLeafEntryId: "anchor" });
      await appendTranscriptMessage(scope, {
        eventId: "newer",
        message: { role: "assistant", content: "newer answer" },
      });
      const selector = {
        sessionId: scope.sessionId,
        messageId: "anchor",
        limit: 80,
        maxBytes,
        maxChars: 1024,
      };
      const ordinary = historyPayload(await request("chat.history", selector));
      expect(ordinary.messages).toMatchObject([
        { __openclaw: { id: "preceding" } },
        { __openclaw: { id: "anchor", truncated: true } },
        { __openclaw: { id: "newer" } },
      ]);
      const ordinaryBytes = Buffer.byteLength(JSON.stringify(ordinary.messages));
      expect(ordinaryBytes).toBeLessThanOrEqual(maxBytes);
      const continued = historyPayload(
        await request("chat.history", {
          ...selector,
          continuity: { cursor: before.deltaCursor, activeLeafEntryId: "anchor" },
        }),
      );
      expect(continued).toMatchObject({
        continuity: {
          cursor: before.deltaCursor,
          activeLeafEntryId: "anchor",
          accepted: true,
        },
        sessionInfo: { sessionId: scope.sessionId, activeLeafEntryId: "newer" },
      });
      expect(continued.messages).toEqual(ordinary.messages);
      expect(Buffer.byteLength(JSON.stringify(continued.messages))).toBe(ordinaryBytes);
    });
  },
);

it("validates explicit incognito continuity through actor custody without a native history worker", async () => {
  await withHistoryState(async () => {
    await captureRuntimeConfigAsyncReader()();
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:incognito-continuity",
      sessionId: "private-current",
    };
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      incognito: true,
    });
    await appendTranscriptMessage(scope, {
      eventId: "private-root",
      message: { role: "user", content: "private root" },
    });
    const request = historyRpc(await createHistoryReadContext(), scope.sessionKey);
    const before = historyPayload(await request("chat.history"));
    assert(typeof before.deltaCursor === "string");
    expect(before.sessionInfo).toMatchObject({ activeLeafEntryId: "private-root" });
    await appendTranscriptMessage(scope, {
      eventId: "private-next",
      message: { role: "assistant", content: "private append" },
    });
    const sibling = {
      ...scope,
      sessionKey: "agent:main:dashboard:incognito-sibling",
      sessionId: "private-sibling",
    };
    await upsertSessionEntryCore(sibling, {
      sessionId: sibling.sessionId,
      updatedAt: 1,
      incognito: true,
    });
    await appendTranscriptMessage(sibling, {
      eventId: "sibling-root",
      message: { role: "user", content: "other private owner" },
    });

    using worker = vi
      .spyOn(historyWorker, "readSessionHistoryPageInWorker")
      .mockImplementation(async () => {
        throw new Error("incognito history must not enter a native history worker");
      });
    const selector = {
      sessionId: scope.sessionId,
      messageId: "private-root",
      limit: 80,
      maxBytes: 256 * 1024,
    };
    expectHistoryPayload(await request("chat.history", selector), {
      messages: [
        expect.objectContaining({ content: "private root" }),
        expect.objectContaining({ content: "private append" }),
      ],
    });
    expectHistoryPayload(
      await request("chat.history", {
        ...selector,
        continuity: { cursor: before.deltaCursor, activeLeafEntryId: "private-root" },
      }),
      {
        continuity: {
          cursor: before.deltaCursor,
          activeLeafEntryId: "private-root",
          accepted: true,
        },
        sessionInfo: expect.objectContaining({
          sessionId: scope.sessionId,
          activeLeafEntryId: "private-next",
        }),
      },
    );
    expectWrongSession(
      await request("chat.history", {
        sessionId: sibling.sessionId,
        messageId: "sibling-root",
      }),
    );
    expectHistoryError(
      await request("chat.history", {
        ...selector,
        sessionId: sibling.sessionId,
        continuity: { cursor: before.deltaCursor, activeLeafEntryId: "private-root" },
      }),
      {
        code: "UNAVAILABLE",
        message: "session changed while reading history; reload the conversation",
      },
    );
    expect(worker).not.toHaveBeenCalled();
  });
});
