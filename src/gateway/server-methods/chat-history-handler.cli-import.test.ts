import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { readChatHistoryMessageId } from "../session-history-tail.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";

type HistoryPage = {
  messages: unknown[];
  completeSnapshot?: boolean;
  hasMore?: boolean;
  nextOffset?: number;
  offset?: number;
  totalMessages?: number;
};

type HistoryRequest = {
  limit?: number;
  maxBytes?: number;
  messageId?: string;
  offset?: number;
};

async function withImportedHistory(
  method: "chat.history" | "chat.startup",
  importedCount: number,
  text: string,
  run: (fixture: {
    read: (params: HistoryRequest) => Promise<HistoryPage>;
    importedIds: string[];
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:cli-history-anchor",
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
    const context = createDirectChatContext();
    const handler = expectDefined(chatHistoryHandlers[method], "history handler");
    const read = async (params: HistoryRequest): Promise<HistoryPage> => {
      let result: HistoryPage | undefined;
      await handler({
        params: { sessionKey: scope.sessionKey, ...params },
        context,
        req: { type: "req", id: "cli-history-anchor", method },
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
    await run({ read, importedIds });
  });
}

function expectMissingAnchor(page: HistoryPage) {
  expect(page.messages).toEqual([]);
  for (const key of ["offset", "nextOffset", "hasMore", "totalMessages", "completeSnapshot"]) {
    expect(page).not.toHaveProperty(key);
  }
}

describe("CLI-imported history anchors", () => {
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
      const handler = expectDefined(chatHistoryHandlers["chat.history"], "history handler");
      let result: HistoryPage | undefined;
      await handler({
        params: { sessionKey: scope.sessionKey, messageId: local.messageId, limit: 2 },
        context: createDirectChatContext(),
        req: { type: "req", id: "metadata-anchor", method: "chat.history" },
        client: null,
        isWebchatConnect: () => false,
        respond: (ok, payload, error) => {
          expect(error).toBeUndefined();
          expect(ok).toBe(true);
          result = payload as HistoryPage;
        },
      });
      const anchored = expectDefined(result, "history response").messages.find(
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
      const context = createDirectChatContext();
      const handler = expectDefined(chatHistoryHandlers["chat.history"], "history handler");
      const read = async (params: HistoryRequest) => {
        let result: HistoryPage | undefined;
        await handler({
          params: { sessionKey: scope.sessionKey, ...params },
          context,
          req: { type: "req", id: randomUUID(), method: "chat.history" },
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
      const handler = expectDefined(chatHistoryHandlers["chat.history"], "history handler");
      let result: HistoryPage | undefined;
      await handler({
        params: { sessionKey: scope.sessionKey, limit: 1, offset: 1 },
        context: createDirectChatContext(),
        req: { type: "req", id: "metadata-recovery", method: "chat.history" },
        client: null,
        isWebchatConnect: () => false,
        respond: (ok, payload, error) => {
          expect(error).toBeUndefined();
          expect(ok).toBe(true);
          result = payload as HistoryPage;
        },
      });

      const messages = expectDefined(result, "history response").messages;
      expect(messages.map(readChatHistoryMessageId)).toEqual([localUser.messageId]);
      expect(asOptionalRecord(asOptionalRecord(messages[0])?.["__openclaw"])).toMatchObject({
        importedFrom: "claude-cli",
        externalId: importedId,
        cliSessionId,
      });
    });
  });

  it.each(["chat.history", "chat.startup"] as const)(
    "%s distinguishes missing anchors from terminal imported snapshots",
    async (method) => {
      await withImportedHistory(
        method,
        6,
        "External conversation ".repeat(100),
        async ({ read, importedIds }) => {
          const newest = await read({ limit: 2, maxBytes: 1024 });
          expect(newest.messages).toHaveLength(8);
          expect(newest).toMatchObject({
            completeSnapshot: true,
            hasMore: false,
            totalMessages: 8,
          });
          expect(newest.messages.map(readChatHistoryMessageId)).toEqual([
            expect.any(String),
            expect.any(String),
            ...importedIds,
          ]);
          for (const params of [
            { messageId: importedIds[0] },
            { offset: 0 },
            { offset: 2 },
            { offset: 9999 },
          ]) {
            const page = await read({ ...params, limit: 2 });
            expect(page.messages).toEqual(newest.messages);
            expect(page).toMatchObject({
              completeSnapshot: true,
              hasMore: false,
              totalMessages: 8,
            });
          }
          expectMissingAnchor(await read({ messageId: "nonexistent-anchor", limit: 2 }));
        },
      );
    },
  );

  it("does not substitute the newest byte-capped suffix for a missing imported anchor", async () => {
    await withImportedHistory(
      "chat.history",
      1000,
      "x".repeat(7900),
      async ({ read, importedIds }) => {
        const newest = await read({ limit: 2 });
        const newestIds = newest.messages.map(readChatHistoryMessageId);
        expect(newestIds.length).toBeGreaterThan(0);
        expect(newestIds.length).toBeLessThan(importedIds.length);
        expect(newestIds).not.toContain(importedIds[0]);
        expect(newestIds.at(-1)).toBe(importedIds.at(-1));
        expect(newest).toMatchObject({ hasMore: false, totalMessages: 1002 });
        expect(newest).not.toHaveProperty("completeSnapshot");
        const anchored = await read({ messageId: importedIds[0], limit: 2 });
        expect(anchored.messages.map(readChatHistoryMessageId)).toContain(importedIds[0]);
        expect(anchored.messages.map(readChatHistoryMessageId)).not.toContain(importedIds.at(-1));
        expectMissingAnchor(await read({ messageId: "nonexistent-anchor", limit: 2 }));
      },
    );
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
      const handler = expectDefined(chatHistoryHandlers["chat.history"], "history handler");
      let result: unknown;
      await handler({
        params: { sessionKey: scope.sessionKey, messageId: hidden.messageId, limit: 2 },
        context: createDirectChatContext(),
        req: { type: "req", id: "filtered-anchor", method: "chat.history" },
        client: null,
        isWebchatConnect: () => false,
        respond: (ok, payload, error) => {
          expect(error).toBeUndefined();
          expect(ok).toBe(true);
          result = payload;
        },
      });
      expect(asOptionalRecord(result)?.messages).toEqual([]);
    });
  });
});
