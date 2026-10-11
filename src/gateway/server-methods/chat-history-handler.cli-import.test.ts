import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { STREAM_ERROR_FALLBACK_TEXT } from "@openclaw/ai/internal/shared";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { readLoggingConfig } from "../../logging/config.js";
import { applyLoggingConfig } from "../../logging/logger.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../../logging/secret-redaction-registry.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readChatHistoryMessageId } from "../session-history-tail.js";
import { readSessionMessageByIdAsync } from "../session-transcript-readers.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { chatMessageGetHandlers } from "./chat-message-get-handler.js";

type HistoryPage = {
  messages: unknown[];
  completeSnapshot?: boolean;
  hasMore?: boolean;
  nextOffset?: number;
  offset?: number;
  olderCursor?: string;
  newerCursor?: string;
  totalMessages?: number;
  windowReset?: boolean;
};

type HistoryRequest = {
  cursor?: string;
  limit?: number;
  maxBytes?: number;
  messageId?: string;
  offset?: number;
};

async function historyReader(
  sessionKey: string,
  method: "chat.history" | "chat.startup" = "chat.history",
) {
  const context = await createHistoryReadContext();
  const handler = expectDefined(chatHistoryHandlers[method], "history handler");
  return async (params: HistoryRequest): Promise<HistoryPage> => {
    let result: HistoryPage | undefined;
    await handler({
      params: { sessionKey, ...params },
      context,
      req: { type: "req", id: randomUUID(), method },
      client: null,
      isWebchatConnect: () => false,
      respond: (ok, payload, error) => {
        expect(error).toBeUndefined();
        expect(ok).toBe(true);
        result = payload as HistoryPage;
      },
    });
    return expectDefined(result, "history response");
  };
}

async function withImportedHistory(
  method: "chat.history" | "chat.startup",
  importedCount: number,
  text: string,
  run: (fixture: {
    read: (params: HistoryRequest) => Promise<HistoryPage>;
    importedIds: string[];
    sourcePath: string;
    sessionsDir: string;
    scope: { agentId: string; sessionId: string; sessionKey: string };
  }) => Promise<void>,
  incognito = false,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionKey: incognito
        ? "agent:main:dashboard:incognito-cli-history"
        : "agent:main:cli-history-anchor",
      sessionId: randomUUID(),
    };
    const cliSessionId = randomUUID();
    const timestamp = Date.parse("2026-09-01T10:00:00Z");
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: incognito ? Date.now() : timestamp,
      ...(incognito ? { incognito: true as const } : {}),
      providerOverride: "claude-cli",
      modelOverride: "claude-sonnet-4-6",
      cliSessionBindings: { "claude-cli": { sessionId: cliSessionId } },
    });
    await appendTranscriptMessage(scope, {
      message: { role: "user", content: "Local question", timestamp },
    });
    await appendTranscriptMessage(scope, {
      message: { role: "assistant", content: "Local answer", timestamp: timestamp + 1 },
    });
    const importedIds = Array.from({ length: importedCount }, () => randomUUID());
    const projectDir = path.join(state.home, ".claude", "projects", "synthetic-history");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, `${cliSessionId}.jsonl`),
      importedIds
        .map((uuid, index) => {
          const role = index % 2 === 0 ? "user" : "assistant";
          return JSON.stringify({
            type: role,
            uuid,
            parentUuid: importedIds[index - 1] ?? null,
            sessionId: cliSessionId,
            timestamp: new Date(timestamp + index + 2).toISOString(),
            message: { role, content: `Imported ${index}: ${text}` },
          });
        })
        .join("\n") + "\n",
    );
    await run({
      read: await historyReader(scope.sessionKey, method),
      importedIds,
      sourcePath: path.join(projectDir, `${cliSessionId}.jsonl`),
      sessionsDir: state.sessionsDir(),
      scope,
    });
  });
}

function expectMissingAnchor(page: HistoryPage) {
  expect(page.messages).toEqual([]);
  for (const key of ["offset", "nextOffset", "hasMore", "totalMessages", "completeSnapshot"]) {
    expect(page).not.toHaveProperty(key);
  }
}

describe("CLI-imported history pages", () => {
  it.each([false, true])(
    "opens imported-only full messages through the history index (incognito: %s)",
    async (incognito) => {
      const text = "Imported full-message content. ".repeat(350);
      await withImportedHistory(
        "chat.history",
        1,
        text,
        async ({ read, importedIds, scope }) => {
          const messageId = importedIds[0]!;
          const page = await read({ limit: 10 });
          expect(page.messages.map(readChatHistoryMessageId)).toContain(messageId);
          expect(await readSessionMessageByIdAsync(scope, messageId)).toMatchObject({
            found: false,
          });
          const context = await createHistoryReadContext();
          let message: unknown;
          await expectDefined(
            chatMessageGetHandlers["chat.message.get"],
            "message handler",
          )({
            params: { sessionKey: scope.sessionKey, messageId },
            context,
            req: { type: "req", id: randomUUID(), method: "chat.message.get" },
            client: null,
            isWebchatConnect: () => false,
            respond: (ok, payload, error) => {
              expect(error).toBeUndefined();
              expect(ok).toBe(true);
              expect(payload).toMatchObject({ ok: true });
              message = asOptionalRecord(payload)?.message;
            },
          });
          expect(message).toMatchObject({
            role: "user",
            content: `Imported 0: ${text}`,
            __openclaw: { id: messageId, importedFrom: "claude-cli" },
          });
        },
        incognito,
      );
    },
  );

  it("shares canonical archive and visibility outcomes between CLI reply previews and full messages", async () => {
    await withImportedHistory(
      "chat.history",
      1,
      "seed",
      async ({ read, sourcePath, sessionsDir, scope }) => {
        await upsertSessionEntryCore(scope, { sessionStartedAt: 2000 });
        await replaceTranscriptEvents(scope, [
          { type: "session", version: 3, id: scope.sessionId },
          {
            type: "message",
            id: "canonical-announce",
            parentId: null,
            message: {
              role: "user",
              timestamp: 1000,
              content: "Old canonical completion",
              provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
            },
          },
          {
            type: "message",
            id: "reused-hidden",
            parentId: "canonical-announce",
            message: { role: "assistant", timestamp: 1100, content: "Hidden canonical reply" },
          },
          ...["archived-original", "reused-hidden"].map((replyToId, index) => ({
            type: "message",
            id: `quote-${replyToId}`,
            parentId: index === 0 ? "reused-hidden" : "quote-archived-original",
            message: {
              role: "user",
              timestamp: 5000 + index,
              content: `Quote ${replyToId}`,
              __openclaw: { replyToId },
            },
          })),
        ]);
        await fs.mkdir(sessionsDir, { recursive: true });
        await fs.writeFile(
          path.join(sessionsDir, `${scope.sessionId}.jsonl.reset.2026-09-30T00-00-00.000Z`),
          [
            { type: "session", version: 3, id: scope.sessionId },
            {
              type: "message",
              id: "archived-original",
              parentId: null,
              message: { role: "assistant", timestamp: 100, content: "Retained archive original" },
            },
          ]
            .map((event) => JSON.stringify(event))
            .join("\n") + "\n",
        );
        await fs.writeFile(
          sourcePath,
          [
            {
              id: "native-announce",
              role: "user",
              timestamp: 500,
              content:
                "[Inter-session message] sourceTool=subagent_announce\nOld native completion",
            },
            { id: "native-pair", role: "assistant", timestamp: 600, content: "Hidden native pair" },
            {
              id: "native-visible",
              role: "assistant",
              timestamp: 3000,
              content: "Visible native original",
            },
            // Missing native announce context must not revive an ID rejected by canonical history.
            {
              id: "reused-hidden",
              role: "assistant",
              timestamp: 4000,
              content: "Native copy of hidden ID",
            },
          ]
            .map(({ id, role, timestamp, content }) =>
              JSON.stringify({
                type: role,
                uuid: id,
                timestamp: new Date(timestamp).toISOString(),
                message: { role, content },
              }),
            )
            .join("\n") + "\n",
        );
        const page = await read({ limit: 10 });
        expect(page.messages.map(readChatHistoryMessageId)).not.toContain("native-pair");
        expect(
          page.messages.find(
            (message) => readChatHistoryMessageId(message) === "quote-archived-original",
          ),
        ).toHaveProperty("__openclaw.replyToMessage", {
          ok: true,
          message: expect.objectContaining({ content: "Retained archive original" }),
        });
        expect(
          page.messages.find(
            (message) => readChatHistoryMessageId(message) === "quote-reused-hidden",
          ),
        ).toHaveProperty("__openclaw.replyToMessage", {
          ok: false,
          unavailableReason: "not_found",
        });
        const context = await createHistoryReadContext();
        const results: unknown[] = [];
        for (const messageId of [
          "archived-original",
          "native-pair",
          "reused-hidden",
          "native-visible",
        ]) {
          await expectDefined(
            chatMessageGetHandlers["chat.message.get"],
            "message handler",
          )({
            params: { sessionKey: scope.sessionKey, messageId },
            context,
            req: { type: "req", id: randomUUID(), method: "chat.message.get" },
            client: null,
            isWebchatConnect: () => false,
            respond: (ok, payload, error) => {
              expect(error).toBeUndefined();
              expect(ok).toBe(true);
              results.push([messageId, payload]);
            },
          });
        }
        expect(results).toEqual([
          [
            "archived-original",
            {
              ok: true,
              message: expect.objectContaining({ content: "Retained archive original" }),
            },
          ],
          ["native-pair", { ok: false, unavailableReason: "not_found" }],
          ["reused-hidden", { ok: false, unavailableReason: "not_found" }],
          [
            "native-visible",
            { ok: true, message: expect.objectContaining({ content: "Visible native original" }) },
          ],
        ]);
      },
    );
  });

  it("retains metadata-only imports on anchored history reads", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:cli-history-metadata-anchor",
        sessionId: randomUUID(),
      };
      const cliSessionId = randomUUID();
      const importedId = randomUUID();
      const timestamp = Date.parse("2026-09-01T10:00:00Z");
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: timestamp,
        providerOverride: "claude-cli",
        modelOverride: "claude-sonnet-4-6",
        cliSessionBindings: { "claude-cli": { sessionId: cliSessionId } },
      });
      const local = await appendTranscriptMessage(scope, {
        message: { role: "assistant", content: "Deduplicated answer", timestamp },
      });
      const projectDir = path.join(state.home, ".claude", "projects", "synthetic-history");
      await fs.mkdir(projectDir, { recursive: true });
      await fs.writeFile(
        path.join(projectDir, `${cliSessionId}.jsonl`),
        `${JSON.stringify({
          type: "assistant",
          uuid: importedId,
          parentUuid: null,
          sessionId: cliSessionId,
          timestamp: new Date(timestamp).toISOString(),
          message: { role: "assistant", content: "Deduplicated answer" },
        })}\n`,
      );
      const read = await historyReader(scope.sessionKey);
      const result = await read({
        messageId: local.messageId,
        limit: 2,
      });
      const anchored = result.messages.find(
        (message) => readChatHistoryMessageId(message) === local.messageId,
      );
      expect(asOptionalRecord(asOptionalRecord(anchored)?.["__openclaw"])).toMatchObject({
        importedFrom: "claude-cli",
        externalId: importedId,
        cliSessionId,
      });
    });
  });

  it("advances offset pages when imports only add metadata", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:cli-history-metadata-pages",
        sessionId: randomUUID(),
      };
      const cliSessionId = randomUUID();
      const timestamp = Date.parse("2026-09-01T10:00:00Z");
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: timestamp,
        providerOverride: "claude-cli",
        modelOverride: "claude-sonnet-4-6",
        cliSessionBindings: { "claude-cli": { sessionId: cliSessionId } },
      });
      const localIds: string[] = [];
      const importedRows: string[] = [];
      for (let index = 0; index < 6; index += 1) {
        const content = `Deduplicated answer ${index}`;
        const messageTimestamp = timestamp + index;
        const local = await appendTranscriptMessage(scope, {
          message: { role: "assistant", content, timestamp: messageTimestamp },
        });
        localIds.push(local.messageId);
        importedRows.push(
          JSON.stringify({
            type: "assistant",
            uuid: randomUUID(),
            parentUuid: null,
            sessionId: cliSessionId,
            timestamp: new Date(messageTimestamp).toISOString(),
            message: { role: "assistant", content },
          }),
        );
      }
      const projectDir = path.join(state.home, ".claude", "projects", "synthetic-history");
      await fs.mkdir(projectDir, { recursive: true });
      await fs.writeFile(
        path.join(projectDir, `${cliSessionId}.jsonl`),
        `${importedRows.join("\n")}\n`,
      );
      const read = await historyReader(scope.sessionKey);

      const newest = await read({ limit: 2, offset: 0 });
      expect(newest.messages.map(readChatHistoryMessageId)).toEqual(localIds.slice(-2));
      expect(newest.nextOffset).toBe(2);
      const older = await read({ limit: 2, offset: newest.nextOffset });
      expect(older.messages.map(readChatHistoryMessageId)).toEqual(localIds.slice(2, 4));
      expect(older.nextOffset).toBe(4);
    });
  });

  it("preserves recovered-failure filtering on metadata-only offset pages", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:cli-history-metadata-recovery",
        sessionId: randomUUID(),
      };
      const cliSessionId = randomUUID();
      const importedId = randomUUID();
      const timestamp = Date.parse("2026-09-01T10:00:00Z");
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: timestamp,
        providerOverride: "claude-cli",
        modelOverride: "claude-sonnet-4-6",
        cliSessionBindings: { "claude-cli": { sessionId: cliSessionId } },
      });
      const localUser = await appendTranscriptMessage(scope, {
        message: { role: "user", content: "Question", timestamp },
      });
      await appendTranscriptMessage(scope, {
        message: {
          role: "assistant",
          content: [],
          timestamp: timestamp + 1,
          stopReason: "error",
          errorMessage: "The selected model is unavailable.",
          __openclaw: { runId: "recovered-run" },
        },
      });
      await appendTranscriptMessage(scope, {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Recovered answer" }],
          timestamp: timestamp + 2,
          stopReason: "stop",
          __openclaw: { runId: "recovered-run" },
        },
      });
      const projectDir = path.join(state.home, ".claude", "projects", "synthetic-history");
      await fs.mkdir(projectDir, { recursive: true });
      await fs.writeFile(
        path.join(projectDir, `${cliSessionId}.jsonl`),
        `${JSON.stringify({
          type: "user",
          uuid: importedId,
          parentUuid: null,
          sessionId: cliSessionId,
          timestamp: new Date(timestamp).toISOString(),
          message: { role: "user", content: "Question" },
        })}\n`,
      );
      const read = await historyReader(scope.sessionKey);
      const { messages } = await read({ limit: 1, offset: 1 });
      expect(messages.map(readChatHistoryMessageId)).toEqual([localUser.messageId]);
      expect(asOptionalRecord(asOptionalRecord(messages[0])?.["__openclaw"])).toMatchObject({
        importedFrom: "claude-cli",
        externalId: importedId,
        cliSessionId,
      });
    });
  });

  it.each(["chat.history", "chat.startup"] as const)(
    "%s pages local and external history within the requested limits",
    async (method) => {
      await withImportedHistory(
        method,
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
          expect(anchored.messages.map(readChatHistoryMessageId)).toContain(importedIds[0]);
          expectMissingAnchor(await read({ messageId: "nonexistent-anchor", limit: 2 }));
          expect((await read({ offset: 9999, limit: 2 })).messages).toEqual([]);
        },
      );
    },
  );

  it("pages external and local rows from process-held incognito history", async () => {
    await withImportedHistory(
      "chat.history",
      2,
      "Private native history",
      async ({ read, importedIds }) => {
        const newest = await read({ limit: 2 });
        expect(newest.messages.map(readChatHistoryMessageId)).toEqual(importedIds);
        expect(newest).toMatchObject({ totalMessages: 4, hasMore: true, nextOffset: 2 });
        const older = await read({ offset: newest.nextOffset, limit: 2 });
        expect(older).toMatchObject({ hasMore: false, totalMessages: 4 });
        expect(JSON.stringify(older.messages)).toContain("Local question");
        expect(JSON.stringify(older.messages)).toContain("Local answer");
      },
      true,
    );
  });

  it("redacts before worker dedupe and invalidates unchanged native history when policy changes", async () => {
    await withImportedHistory(
      "chat.history",
      2,
      "opaqueSeedQ customMask7 laterRegV7 laterCfgV8",
      async ({ read, scope, importedIds }) => {
        const previousLogging = readLoggingConfig();
        try {
          registerSecretValueForRedaction("opaqueSeedQ");
          applyLoggingConfig({ redactPatterns: ["customMask7"] });
          const local = await appendTranscriptMessage(scope, {
            message: {
              role: "user",
              content: "Imported 0: opaqueSeedQ customMask7 laterRegV7 laterCfgV8",
              timestamp: Date.parse("2026-09-01T10:00:00Z") + 2,
            },
          });
          const initial = await read({ limit: 10 });
          expect(initial.totalMessages).toBe(4);
          expect(initial.messages).toContainEqual(
            expect.objectContaining({
              content: "Imported 0: *** *** laterRegV7 laterCfgV8",
              __openclaw: expect.objectContaining({
                id: local.messageId,
                externalId: importedIds[0],
              }),
            }),
          );
          expect(JSON.stringify(initial.messages)).not.toContain("opaqueSeedQ");
          expect(JSON.stringify(initial.messages)).not.toContain("customMask7");
          registerSecretValueForRedaction("laterRegV7");
          applyLoggingConfig({ redactPatterns: ["customMask7", "laterCfgV8"] });
          const refreshed = await read({ limit: 1 });
          expect(refreshed.messages).toEqual([
            expect.objectContaining({
              content: "Imported 1: *** *** *** ***",
              __openclaw: expect.objectContaining({ id: importedIds[1] }),
            }),
          ]);
        } finally {
          applyLoggingConfig(previousLogging);
          resetSecretRedactionRegistryForTest();
        }
      },
    );
  });

  it("invalidates merged pages after native replacement, local append, and native deletion", async () => {
    await withImportedHistory(
      "chat.history",
      6,
      "Original",
      async ({ read, sourcePath, scope }) => {
        expect(await read({ limit: 2 })).toMatchObject({ totalMessages: 8, hasMore: true });
        await fs.writeFile(
          sourcePath,
          JSON.stringify({
            type: "assistant",
            uuid: "replacement-native",
            timestamp: "2026-09-01T10:00:01Z",
            message: { role: "assistant", content: "Replacement native answer" },
          }) + "\n",
        );
        const replaced = await read({ limit: 2 });
        expect(replaced.totalMessages).toBe(3);
        expect(replaced.messages.map(readChatHistoryMessageId)).toContain("replacement-native");
        const appended = await appendTranscriptMessage(scope, {
          message: {
            role: "assistant",
            content: "New local answer",
            timestamp: Date.parse("2026-09-01T10:00:02Z"),
          },
        });
        const newest = await read({ limit: 2 });
        expect(newest.totalMessages).toBe(4);
        expect(readChatHistoryMessageId(newest.messages.at(-1))).toBe(appended.messageId);
        await fs.rm(sourcePath);
        const deleted = await read({ limit: 2 });
        expect(deleted.totalMessages).toBe(3);
        expect(deleted.messages.map(readChatHistoryMessageId)).not.toContain("replacement-native");
        expect(readChatHistoryMessageId(deleted.messages.at(-1))).toBe(appended.messageId);
      },
    );
  });

  it("does not substitute the newest byte-capped suffix for a missing imported anchor", async () => {
    await withImportedHistory(
      "chat.history",
      40,
      "x".repeat(7900),
      async ({ read, importedIds }) => {
        const newest = await read({ limit: 2 });
        const newestIds = newest.messages.map(readChatHistoryMessageId);
        expect(newestIds.length).toBeGreaterThan(0);
        expect(newestIds.length).toBeLessThan(importedIds.length);
        expect(newestIds).not.toContain(importedIds[0]);
        expect(newestIds.at(-1)).toBe(importedIds.at(-1));
        expect(newest).toMatchObject({ hasMore: true, totalMessages: 42 });
        expect(newest).not.toHaveProperty("completeSnapshot");
        const anchored = await read({ messageId: importedIds[0], limit: 2 });
        expect(anchored.messages.map(readChatHistoryMessageId)).toContain(importedIds[0]);
        expect(anchored.messages.map(readChatHistoryMessageId)).not.toContain(importedIds.at(-1));
        expectMissingAnchor(await read({ messageId: "nonexistent-anchor", limit: 2 }));
      },
    );
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
      const scope = {
        agentId: "main",
        sessionKey: `agent:main:cli-history-pre-reset-${randomUUID()}`,
        sessionId: randomUUID(),
      };
      const cliSessionId = randomUUID();
      const timestamp = Date.parse("2026-09-06T22:00:00Z");
      const resetAt = Date.parse("2026-10-06T20:29:44Z");
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: resetAt + 10,
        sessionStartedAt: resetAt,
        providerOverride: "claude-cli",
        modelOverride: "claude-opus-5-5",
        ...(bindCli ? { cliSessionBindings: { "claude-cli": { sessionId: cliSessionId } } } : {}),
      });
      await appendTranscriptMessage(scope, {
        eventId: "old-question",
        message: { role: "user", content: "Old question", timestamp },
      });
      await appendTranscriptMessage(scope, {
        eventId: "old-answer",
        message: { role: "assistant", content: "Old answer", timestamp: timestamp + 1 },
      });
      await appendTranscriptEvent(scope, {
        type: "reset",
        id: "reset",
        parentId: "old-answer",
        timestamp: new Date(resetAt).toISOString(),
        reason: "new",
        ...(keepOldAnswer ? { firstKeptEntryId: "old-answer" } : {}),
      });
      await appendTranscriptMessage(scope, {
        eventId: "fresh-question",
        message: { role: "user", content: "Fresh question", timestamp: resetAt + 1 },
      });
      // Reset clears CLI bindings, so the bound Claude transcript only knows
      // post-reset rows; this CLI-only row makes the merge expand.
      const projectDir = path.join(state.home, ".claude", "projects", "synthetic-history");
      await fs.mkdir(projectDir, { recursive: true });
      await fs.writeFile(
        path.join(projectDir, `${cliSessionId}.jsonl`),
        `${JSON.stringify({
          type: "assistant",
          uuid: "cli-only-answer",
          parentUuid: null,
          sessionId: cliSessionId,
          timestamp: new Date(resetAt + 2).toISOString(),
          message: { role: "assistant", content: "CLI-only answer" },
        })}\n`,
      );
      await run(await historyReader(scope.sessionKey));
    });
  }

  const ids = (page: HistoryPage) => page.messages.map(readChatHistoryMessageId);

  it("reopens a pre-reset local anchor while a post-reset CLI import is bound", async () => {
    await withPreResetCliHistory(false, true, async (read) => {
      const current = await read({ messageId: "fresh-question", limit: 2 });
      expect(ids(current)).toContain("cli-only-answer");

      const reopened = await read({ messageId: "old-answer", limit: 2 });
      expect(ids(reopened)).toContain("old-answer");
      expect(ids(reopened)).not.toContain("fresh-question");
      expect(ids(reopened)).not.toContain("cli-only-answer");

      // The reopened page keeps its own reset-interval sequence for paging.
      const reopenedTail = await read({ messageId: "old-answer", limit: 1 });
      expect(ids(reopenedTail)).toEqual(["old-answer"]);
      expect(reopenedTail.olderCursor).toEqual(expect.any(String));

      expectMissingAnchor(await read({ messageId: "nonexistent-anchor", limit: 2 }));
    });
  });

  it("keeps reopened-interval cursors on the closed interval across its reset marker", async () => {
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

  it("pages a reopened interval into a message retained across the reset", async () => {
    await withPreResetCliHistory(true, true, async (read) => {
      const reopened = await read({ messageId: "old-question", limit: 1 });
      expect(ids(reopened)).toEqual(["old-question"]);

      // old-answer lives in both the closed interval and the current index.
      const newer = await read({ cursor: reopened.newerCursor, limit: 1 });
      expect(newer.windowReset).toBeUndefined();
      expect(ids(newer)).toEqual(["old-answer"]);
    });
  });

  it("keeps a current-window failure hidden when an imported answer recovers it", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:cli-history-hidden-recovered-failure",
        sessionId: randomUUID(),
      };
      const cliSessionId = randomUUID();
      const timestamp = Date.parse("2026-09-01T10:00:00Z");
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: timestamp,
        providerOverride: "claude-cli",
        modelOverride: "claude-sonnet-4-6",
        cliSessionBindings: { "claude-cli": { sessionId: cliSessionId } },
      });
      await appendTranscriptMessage(scope, {
        message: { role: "user", content: "Question", timestamp },
      });
      const failed = await appendTranscriptMessage(scope, {
        message: {
          role: "assistant",
          content: [{ type: "text", text: STREAM_ERROR_FALLBACK_TEXT }],
          timestamp: timestamp + 1,
          stopReason: "error",
        },
      });
      const projectDir = path.join(state.home, ".claude", "projects", "synthetic-history");
      await fs.mkdir(projectDir, { recursive: true });
      await fs.writeFile(
        path.join(projectDir, `${cliSessionId}.jsonl`),
        [
          {
            type: "user",
            uuid: randomUUID(),
            parentUuid: null,
            sessionId: cliSessionId,
            timestamp: new Date(timestamp).toISOString(),
            message: { role: "user", content: "Question" },
          },
          {
            type: "assistant",
            uuid: "imported-answer",
            parentUuid: null,
            sessionId: cliSessionId,
            timestamp: new Date(timestamp + 2).toISOString(),
            message: { role: "assistant", content: "Recovered answer" },
          },
        ]
          .map((line) => `${JSON.stringify(line)}\n`)
          .join(""),
      );
      const read = await historyReader(scope.sessionKey);
      const newest = await read({ limit: 10 });
      expect(newest.messages.map(readChatHistoryMessageId)).toContain("imported-answer");
      expect(newest.messages.map(readChatHistoryMessageId)).not.toContain(failed.messageId);
      const anchored = await read({ messageId: failed.messageId, limit: 2 });
      expect(anchored.messages.map(readChatHistoryMessageId)).not.toContain(failed.messageId);
    });
  });

  it("does not substitute nearby SQLite messages for a filtered anchor", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:hidden-history-anchor",
        sessionId: randomUUID(),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const hidden = await appendTranscriptMessage(scope, {
        message: { role: "user", content: "Hidden input", display: false },
      });
      await appendTranscriptMessage(scope, {
        message: { role: "assistant", content: "Visible answer" },
      });
      const read = await historyReader(scope.sessionKey);
      const page = await read({ messageId: hidden.messageId, limit: 2 });
      expect(page.messages).toEqual([]);
    });
  });
});
