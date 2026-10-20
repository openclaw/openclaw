import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { STREAM_ERROR_FALLBACK_TEXT } from "@openclaw/ai/internal/shared";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import type { ChatHistoryParams } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { captureRuntimeConfigAsyncReader } from "../../config/config.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { makeCronJob } from "../../cron/delivery.test-helpers.js";
import { resolveCronJobsStorePath, saveCronJobsStore } from "../../cron/store.js";
import { readLoggingConfig } from "../../logging/config.js";
import { applyLoggingConfig } from "../../logging/logger.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../../logging/secret-redaction-registry.test-support.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { readChatHistoryMessageId } from "../session-history-tail.js";
import { readSessionMessageByIdAsync } from "../session-transcript-readers.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { chatMessageGetHandlers } from "./chat-message-get-handler.js";

function appendLocal(
  scope: Parameters<typeof appendTranscriptMessage>[0],
  role: string,
  content: unknown,
  timestamp?: number,
  extra: Record<string, unknown> = {},
  eventId?: string,
) {
  return appendTranscriptMessage(scope, {
    message: { role, content, timestamp, ...extra },
    eventId,
  });
}

async function seedCliHistory(
  state: OpenClawTestState,
  sessionKey: string,
  incognito = false,
  entry: Parameters<typeof upsertSessionEntryCore>[1] = {},
) {
  await captureRuntimeConfigAsyncReader()();
  const scope = { agentId: "main", sessionKey, sessionId: randomUUID() };
  const cliSessionId = randomUUID();
  const timestamp = Date.parse("2026-09-01T10:00:00Z");
  await upsertSessionEntryCore(scope, {
    sessionId: scope.sessionId,
    updatedAt: incognito ? Date.now() : timestamp,
    ...(incognito ? { incognito: true as const } : {}),
    providerOverride: "claude-cli",
    modelOverride: "claude-sonnet-4-6",
    cliSessionBindings: { "claude-cli": { sessionId: cliSessionId } },
    ...entry,
  });
  const projectDir = path.join(state.home, ".claude", "projects", "synthetic-history");
  await fs.mkdir(projectDir, { recursive: true });
  const sourcePath = path.join(projectDir, `${cliSessionId}.jsonl`);
  return {
    scope,
    cliSessionId,
    timestamp,
    sourcePath,
    append: appendLocal.bind(null, scope),
    native: cliMessage.bind(null, cliSessionId),
    write: (rows: unknown[]) => writeCliRows(sourcePath, rows),
  };
}

function cliMessage(
  sessionId: string,
  uuid: string,
  role: string,
  content: string,
  timestamp: number,
  parentUuid: string | null = null,
) {
  return {
    type: role,
    uuid,
    parentUuid,
    sessionId,
    timestamp: new Date(timestamp).toISOString(),
    message: { role, content },
  };
}

function writeCliRows(sourcePath: string, rows: unknown[]) {
  return fs.writeFile(sourcePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

function withCliHistory(
  run: (fixture: Awaited<ReturnType<typeof seedCliHistory>>) => Promise<void>,
) {
  return withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await run(await seedCliHistory(state, "agent:main:cli-history"));
  });
}

const foundMessage = (content: string) => ({
  ok: true,
  message: expect.objectContaining({ content }),
});
const notFound = { ok: false, unavailableReason: "not_found" };

function transcriptMessage(
  id: string,
  parentId: string | null,
  role: string,
  timestamp: number,
  content: string,
  extra: Record<string, unknown> = {},
) {
  return { type: "message", id, parentId, message: { role, timestamp, content, ...extra } };
}

const ids = (page: HistoryPage) => page.messages.map(readChatHistoryMessageId);
const messageWithId = (page: HistoryPage, id: string) =>
  page.messages.find((message) => readChatHistoryMessageId(message) === id);

type HistoryPage = {
  messages: unknown[];
  hasMore?: boolean;
  nextOffset?: number;
  offset?: number;
  olderCursor?: string;
  newerCursor?: string;
  totalMessages?: number;
  windowReset?: boolean;
};

type HistoryRequest = Omit<ChatHistoryParams, "sessionKey">;

async function rpcReader(
  sessionKey: string,
  method: "chat.history" | "chat.startup" | "chat.message.get",
) {
  const context = await createHistoryReadContext();
  const handler = expectDefined(
    method === "chat.message.get" ? chatMessageGetHandlers[method] : chatHistoryHandlers[method],
    "history handler",
  );
  return async (params: HistoryRequest) => {
    let result: unknown;
    await handler({
      params: { sessionKey, ...params },
      context,
      req: { type: "req", id: randomUUID(), method },
      client: null,
      isWebchatConnect: () => false,
      respond: (ok, payload, error) => {
        expect({ ok, error }).toEqual({ ok: true, error: undefined });
        result = payload;
      },
    });
    return expectDefined(result, "history response");
  };
}

async function historyReader(
  sessionKey: string,
  method: "chat.history" | "chat.startup" = "chat.history",
) {
  const read = await rpcReader(sessionKey, method);
  return async (params: HistoryRequest) => (await read(params)) as HistoryPage;
}

async function messageReader(sessionKey: string) {
  const read = await rpcReader(sessionKey, "chat.message.get");
  return (messageId: string) => read({ messageId });
}

async function withImportedHistory(
  importedCount: number,
  text: string,
  run: (
    fixture: {
      read: (params: HistoryRequest) => Promise<HistoryPage>;
      importedIds: string[];
      sessionsDir: string;
    } & Awaited<ReturnType<typeof seedCliHistory>>,
  ) => Promise<void>,
  incognito = false,
  method: "chat.history" | "chat.startup" = "chat.history",
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const fixture = await seedCliHistory(
      state,
      incognito ? "agent:main:dashboard:incognito-cli-history" : "agent:main:cli-history-anchor",
      incognito,
    );
    const { scope, timestamp, native, append, write } = fixture;
    await append("user", "Local question", timestamp);
    await append("assistant", "Local answer", timestamp + 1);
    const importedIds = Array.from({ length: importedCount }, () => randomUUID());
    await write(
      importedIds.map((uuid, index) =>
        native(
          uuid,
          index % 2 === 0 ? "user" : "assistant",
          `Imported ${index}: ${text}`,
          timestamp + index + 2,
          importedIds[index - 1] ?? null,
        ),
      ),
    );
    await run({
      ...fixture,
      read: await historyReader(scope.sessionKey, method),
      importedIds,
      sessionsDir: state.sessionsDir(),
    });
  });
}

function expectMissingAnchor(page: HistoryPage) {
  expect(page.messages).toEqual([]);
  for (const key of ["offset", "nextOffset", "hasMore", "totalMessages", "completeSnapshot"]) {
    expect(page).not.toHaveProperty(key);
  }
}

it.each([false, true])("reads imported full messages (incognito=%s)", async (incognito) => {
  const text = "Imported full-message content. ".repeat(350);
  await withImportedHistory(
    1,
    text,
    async ({ read, importedIds, scope }) => {
      const messageId = importedIds[0]!;
      const page = await read({ limit: 10 });
      expect(ids(page)).toContain(messageId);
      expect(await readSessionMessageByIdAsync(scope, messageId)).toMatchObject({
        found: false,
      });
      const getMessage = await messageReader(scope.sessionKey);
      expect(await getMessage(messageId)).toMatchObject({
        ok: true,
        message: {
          role: "user",
          content: `Imported 0: ${text}`,
          __openclaw: { id: messageId, importedFrom: "claude-cli" },
        },
      });
    },
    incognito,
  );
});

it.each([false, true])(
  "reads cron-forwarded history and quoted failures (incognito=%s)",
  async (incognito) => {
    await withImportedHistory(
      1,
      "Native question",
      async ({ read, append, timestamp, scope }) => {
        await saveCronJobsStore(resolveCronJobsStorePath(), {
          version: 1,
          jobs: [makeCronJob({ id: "daily-report", name: "Daily report" })],
        });
        const partial = await append("assistant", "Partial answer", timestamp + 3, {
          stopReason: "error",
          errorMessage: "Request interrupted",
          __openclaw: { runId: "interrupted-run" },
        });
        const forwarded = await append("user", "Report ready", timestamp + 4, {
          provenance: {
            kind: "inter_session",
            sourceTool: "sessions_send",
            sourceSessionKey: "agent:main:cron:daily-report:run:completed-run",
          },
        });
        const quote = await append("user", "Continue this answer", timestamp + 5, {
          __openclaw: { replyToId: partial.messageId },
        });
        const page = await read({ limit: 10 });
        expect(messageWithId(page, forwarded.messageId)).toMatchObject({
          role: "assistant",
          content: "Report ready",
          senderSession: { label: "Daily report" },
        });
        expect(messageWithId(page, quote.messageId)).toHaveProperty(
          "__openclaw.replyToMessage",
          foundMessage("Partial answer"),
        );
        const getMessage = await messageReader(scope.sessionKey);
        expect(await getMessage(partial.messageId)).toMatchObject(foundMessage("Partial answer"));
        expect(await getMessage(forwarded.messageId)).toMatchObject({
          ok: true,
          message: { senderSession: { label: "Daily report" } },
        });
      },
      incognito,
    );
  },
);

it("shares archive visibility across CLI previews and full messages", async () => {
  await withImportedHistory(1, "seed", async ({ read, sourcePath, sessionsDir, scope }) => {
    await upsertSessionEntryCore(scope, { sessionStartedAt: 2000 });
    await replaceTranscriptEvents(scope, [
      { type: "session", version: 3, id: scope.sessionId },
      transcriptMessage("canonical-announce", null, "user", 1000, "Old canonical completion", {
        provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
      }),
      transcriptMessage(
        "reused-hidden",
        "canonical-announce",
        "assistant",
        1100,
        "Hidden canonical reply",
      ),
      ...["archived-original", "reused-hidden"].map((replyToId, index) =>
        transcriptMessage(
          `quote-${replyToId}`,
          index === 0 ? "reused-hidden" : "quote-archived-original",
          "user",
          5000 + index,
          `Quote ${replyToId}`,
          { __openclaw: { replyToId } },
        ),
      ),
    ]);
    await fs.mkdir(sessionsDir, { recursive: true });
    await writeCliRows(
      path.join(sessionsDir, `${scope.sessionId}.jsonl.reset.2026-09-30T00-00-00.000Z`),
      [
        { type: "session", version: 3, id: scope.sessionId },
        transcriptMessage("archived-original", null, "assistant", 100, "Retained archive original"),
      ],
    );
    await writeCliRows(
      sourcePath,
      (
        [
          [
            "native-announce",
            "user",
            500,
            "[Inter-session message] sourceTool=subagent_announce\nOld native completion",
          ],
          ["native-pair", "assistant", 600, "Hidden native pair"],
          ["native-visible", "assistant", 3000, "Visible native original"],
          // Missing native announce context must not revive an ID rejected by canonical history.
          ["reused-hidden", "assistant", 4000, "Native copy of hidden ID"],
        ] as const
      ).map(([uuid, role, timestamp, content]) => ({
        type: role,
        uuid,
        timestamp: new Date(timestamp).toISOString(),
        message: { role, content },
      })),
    );
    const page = await read({ limit: 10 });
    expect(ids(page)).not.toContain("native-pair");
    expect(messageWithId(page, "quote-archived-original")).toHaveProperty(
      "__openclaw.replyToMessage",
      foundMessage("Retained archive original"),
    );
    expect(messageWithId(page, "quote-reused-hidden")).toHaveProperty(
      "__openclaw.replyToMessage",
      notFound,
    );
    const getMessage = await messageReader(scope.sessionKey);
    const expected = [
      ["archived-original", foundMessage("Retained archive original")],
      ["native-pair", notFound],
      ["reused-hidden", notFound],
      ["native-visible", foundMessage("Visible native original")],
    ] as const;
    const results = [];
    for (const [messageId] of expected) {
      results.push([messageId, await getMessage(messageId)]);
    }
    expect(results).toEqual(expected);
  });
});

it("retains metadata-only imports on anchored history reads", async () => {
  await withCliHistory(async ({ scope, cliSessionId, timestamp, append, native, write }) => {
    const importedId = randomUUID();
    const local = await append("assistant", "Deduplicated answer", timestamp);
    await write([native(importedId, "assistant", "Deduplicated answer", timestamp)]);
    const read = await historyReader(scope.sessionKey);
    const result = await read({ messageId: local.messageId, limit: 2 });
    expect(messageWithId(result, local.messageId)).toMatchObject({
      __openclaw: { importedFrom: "claude-cli", externalId: importedId, cliSessionId },
    });
  });
});

it("advances offset pages when imports only add metadata", async () => {
  await withCliHistory(async ({ scope, timestamp, append, native, write }) => {
    const localIds: string[] = [];
    const importedRows: ReturnType<typeof cliMessage>[] = [];
    for (let index = 0; index < 6; index += 1) {
      const content = `Deduplicated answer ${index}`;
      const messageTimestamp = timestamp + index;
      const local = await append("assistant", content, messageTimestamp);
      localIds.push(local.messageId);
      importedRows.push(native(randomUUID(), "assistant", content, messageTimestamp));
    }
    await write(importedRows);
    const read = await historyReader(scope.sessionKey);

    const newest = await read({ limit: 2, offset: 0 });
    expect(ids(newest)).toEqual(localIds.slice(-2));
    expect(newest.nextOffset).toBe(2);
    const older = await read({ limit: 2, offset: newest.nextOffset });
    expect(ids(older)).toEqual(localIds.slice(2, 4));
    expect(older.nextOffset).toBe(4);
  });
});

it("filters recovered failures on metadata-only pages", async () => {
  await withCliHistory(async ({ scope, cliSessionId, timestamp, append, native, write }) => {
    const importedId = randomUUID();
    const localUser = await append("user", "Question", timestamp);
    await append("assistant", [], timestamp + 1, {
      stopReason: "error",
      errorMessage: "The selected model is unavailable.",
      __openclaw: { runId: "recovered-run" },
    });
    await append("assistant", [{ type: "text", text: "Recovered answer" }], timestamp + 2, {
      stopReason: "stop",
      __openclaw: { runId: "recovered-run" },
    });
    await write([native(importedId, "user", "Question", timestamp)]);
    const read = await historyReader(scope.sessionKey);
    const { messages } = await read({ limit: 1, offset: 1 });
    expect(messages.map(readChatHistoryMessageId)).toEqual([localUser.messageId]);
    expect(messages[0]).toMatchObject({
      __openclaw: { importedFrom: "claude-cli", externalId: importedId, cliSessionId },
    });
  });
});

it.each(["chat.history", "chat.startup"] as const)(
  "%s pages local and external history within the requested limits",
  async (method) => {
    await withImportedHistory(
      6,
      "External conversation",
      async ({ read, importedIds }) => {
        const newest = await read({ limit: 2, maxBytes: 1024 });
        expect(newest.messages.length).toBeLessThanOrEqual(2);
        expect(newest).toMatchObject({ hasMore: true, totalMessages: 8 });
        expect(newest).not.toHaveProperty("completeSnapshot");
        const restored = [...newest.messages];
        let page = newest;
        while (page.hasMore) {
          expect(page.nextOffset).toBeGreaterThan(page.offset ?? 0);
          page = await read({ offset: page.nextOffset, limit: 2, maxBytes: 1024 });
          expect(page.messages.length).toBeLessThanOrEqual(2);
          expect(Buffer.byteLength(JSON.stringify(page.messages))).toBeLessThanOrEqual(1024);
          restored.unshift(...page.messages);
        }
        expect(restored).toHaveLength(8);
        expect(restored.map(readChatHistoryMessageId).slice(2)).toEqual(importedIds);
        expect(JSON.stringify(restored.slice(0, 2))).toContain("Local question");
        expect(JSON.stringify(restored.slice(0, 2))).toContain("Local answer");
        const anchored = await read({ messageId: importedIds[0], limit: 2 });
        expect(anchored.messages.length).toBeLessThanOrEqual(2);
        expect(ids(anchored)).toContain(importedIds[0]);
        expectMissingAnchor(await read({ messageId: "nonexistent-anchor", limit: 2 }));
        expect((await read({ offset: 9999, limit: 2 })).messages).toEqual([]);
      },
      false,
      method,
    );
  },
);

it("paginates process-held incognito imports", async () => {
  await withImportedHistory(
    2,
    "Private native history",
    async ({ read, importedIds }) => {
      const newest = await read({ limit: 2 });
      expect(ids(newest)).toEqual(importedIds);
      expect(newest).toMatchObject({ totalMessages: 4, hasMore: true, nextOffset: 2 });
      const older = await read({ offset: newest.nextOffset, limit: 2 });
      expect(older).toMatchObject({ hasMore: false, totalMessages: 4 });
      expect(JSON.stringify(older.messages)).toContain("Local question");
      expect(JSON.stringify(older.messages)).toContain("Local answer");
    },
    true,
  );
});

it("deduplicates native history independently of log redaction", async () => {
  const text = "opaqueSeedQ customMask7 laterRegV7 laterCfgV8";
  await withImportedHistory(2, text, async ({ read, append, timestamp, importedIds }) => {
    const previousLogging = readLoggingConfig();
    try {
      registerSecretValueForRedaction("opaqueSeedQ");
      applyLoggingConfig({ redactPatterns: ["customMask7"] });
      const local = await append("user", `Imported 0: ${text}`, timestamp + 2);
      const initial = await read({ limit: 10 });
      expect(initial.totalMessages).toBe(4);
      expect(messageWithId(initial, local.messageId)).toMatchObject({
        content: `Imported 0: ${text}`,
        __openclaw: { id: local.messageId, externalId: importedIds[0] },
      });
      registerSecretValueForRedaction("laterRegV7");
      applyLoggingConfig({ redactPatterns: ["customMask7", "laterCfgV8"] });
      const refreshed = await read({ limit: 1 });
      expect(refreshed.messages).toMatchObject([
        {
          content: `Imported 1: ${text}`,
          __openclaw: { id: importedIds[1] },
        },
      ]);
    } finally {
      applyLoggingConfig(previousLogging);
      resetSecretRedactionRegistryForTest();
    }
  });
});

it("invalidates imports on replacement, append, and deletion", async () => {
  await withImportedHistory(
    6,
    "Original",
    async ({ read, sourcePath, append, write, timestamp }) => {
      expect(await read({ limit: 2 })).toMatchObject({ totalMessages: 8, hasMore: true });
      await write([
        {
          type: "assistant",
          uuid: "replacement-native",
          timestamp: "2026-09-01T10:00:01Z",
          message: { role: "assistant", content: "Replacement native answer" },
        },
      ]);
      const replaced = await read({ limit: 2 });
      expect(replaced.totalMessages).toBe(3);
      expect(ids(replaced)).toContain("replacement-native");
      const appended = await append("assistant", "New local answer", timestamp + 2000);
      const newest = await read({ limit: 2 });
      expect(newest.totalMessages).toBe(4);
      expect(readChatHistoryMessageId(newest.messages.at(-1))).toBe(appended.messageId);
      await fs.rm(sourcePath);
      const deleted = await read({ limit: 2 });
      expect(deleted.totalMessages).toBe(3);
      expect(ids(deleted)).not.toContain("replacement-native");
      expect(readChatHistoryMessageId(deleted.messages.at(-1))).toBe(appended.messageId);
    },
  );
});

it("does not substitute byte-capped tails for missing imported anchors", async () => {
  await withImportedHistory(40, "x".repeat(7900), async ({ read, importedIds }) => {
    const newest = await read({ limit: 2 });
    const newestIds = ids(newest);
    expect(newestIds.length).toBeGreaterThan(0);
    expect(newestIds.length).toBeLessThan(importedIds.length);
    expect(newestIds).not.toContain(importedIds[0]);
    expect(newestIds.at(-1)).toBe(importedIds.at(-1));
    expect(newest).toMatchObject({ hasMore: true, totalMessages: 42 });
    expect(newest).not.toHaveProperty("completeSnapshot");
    const anchored = await read({ messageId: importedIds[0], limit: 2 });
    expect(ids(anchored)).toContain(importedIds[0]);
    expect(ids(anchored)).not.toContain(importedIds.at(-1));
    expectMissingAnchor(await read({ messageId: "nonexistent-anchor", limit: 2 }));
  });
});

// Closed interval: old-question, old-answer, reset. The latest window starts at
// fresh-question (or at a retained old-answer), and the bound Claude CLI
// transcript adds a post-reset CLI-only answer.
async function withPreResetCliHistory(
  keepOldAnswer: boolean,
  bindCli: boolean,
  run: (read: (params: HistoryRequest) => Promise<HistoryPage>) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const timestamp = Date.parse("2026-09-06T22:00:00Z");
    const resetAt = Date.parse("2026-10-06T20:29:44Z");
    const { scope, append, native, write } = await seedCliHistory(
      state,
      `agent:main:cli-history-pre-reset-${randomUUID()}`,
      false,
      {
        updatedAt: resetAt + 10,
        sessionStartedAt: resetAt,
        modelOverride: "claude-opus-5-5",
        ...(!bindCli ? { cliSessionBindings: undefined } : {}),
      },
    );
    await append("user", "Old question", timestamp, {}, "old-question");
    await append("assistant", "Old answer", timestamp + 1, {}, "old-answer");
    await appendTranscriptEvent(scope, {
      type: "reset",
      id: "reset",
      parentId: "old-answer",
      timestamp: new Date(resetAt).toISOString(),
      reason: "new",
      ...(keepOldAnswer ? { firstKeptEntryId: "old-answer" } : {}),
    });
    await append("user", "Fresh question", resetAt + 1, {}, "fresh-question");
    // Reset clears CLI bindings, so the bound Claude transcript only knows
    // post-reset rows; this CLI-only row makes the merge expand.
    await write([native("cli-only-answer", "assistant", "CLI-only answer", resetAt + 2)]);
    await run(await historyReader(scope.sessionKey));
  });
}

it("keeps reopened cursors bound across reset markers", async () => {
  // Walk old-answer -> newer (closing reset marker) -> older. The marker is also
  // indexed in the current window; the bound walk must match the unbound one.
  const walk = async (bindCli: boolean) => {
    const pages: Array<{ ids: unknown[]; windowReset?: boolean }> = [];
    await withPreResetCliHistory(false, bindCli, async (read) => {
      const reopened = await read({ messageId: "old-answer", limit: 1 });
      const resetPage = await read({ cursor: reopened.newerCursor, limit: 1 });
      const back = await read({ cursor: resetPage.olderCursor, limit: 1 });
      pages.push(
        ...[reopened, resetPage, back].map((page) => ({
          ids: ids(page),
          windowReset: page.windowReset,
        })),
      );
    });
    return pages;
  };
  const bound = await walk(true);
  expect(bound.slice(0, 2)).toEqual([
    { ids: ["old-answer"], windowReset: undefined },
    { ids: ["reset"], windowReset: undefined },
  ]);
  expect(bound[2]?.windowReset).toBeUndefined();
  expect(bound).toEqual(await walk(false));
});

it("paginates reopened intervals into retained messages", async () => {
  await withPreResetCliHistory(true, true, async (read) => {
    const reopened = await read({ messageId: "old-question", limit: 1 });
    expect(ids(reopened)).toEqual(["old-question"]);

    // old-answer lives in both the closed interval and the current index.
    const newer = await read({ cursor: reopened.newerCursor, limit: 1 });
    expect(newer.windowReset).toBeUndefined();
    expect(ids(newer)).toEqual(["old-answer"]);
  });
});

it("hides current failures recovered by imported answers", async () => {
  await withCliHistory(async ({ scope, timestamp, append, native, write }) => {
    await append("user", "Question", timestamp);
    const failed = await append(
      "assistant",
      [{ type: "text", text: STREAM_ERROR_FALLBACK_TEXT }],
      timestamp + 1,
      { stopReason: "error" },
    );
    await write([
      native(randomUUID(), "user", "Question", timestamp),
      native("imported-answer", "assistant", "Recovered answer", timestamp + 2),
    ]);
    const read = await historyReader(scope.sessionKey);
    const newest = await read({ limit: 10 });
    expect(ids(newest)).toContain("imported-answer");
    expect(ids(newest)).not.toContain(failed.messageId);
    const anchored = await read({ messageId: failed.messageId, limit: 2 });
    expect(ids(anchored)).not.toContain(failed.messageId);
  });
});

it("does not substitute SQLite neighbors for filtered anchors", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    await captureRuntimeConfigAsyncReader()();
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:hidden-history-anchor",
      sessionId: randomUUID(),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const hidden = await appendLocal(scope, "user", "Hidden input", undefined, { display: false });
    await appendLocal(scope, "assistant", "Visible answer");
    const read = await historyReader(scope.sessionKey);
    expect((await read({ messageId: hidden.messageId, limit: 2 })).messages).toEqual([]);
  });
});
