import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect } from "vitest";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";

export type HistoryPage = {
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

export type HistoryRequest = {
  cursor?: string;
  limit?: number;
  maxBytes?: number;
  messageId?: string;
  offset?: number;
};

export type HistoryReadOptions = {
  acceptsSerializedJson?: boolean;
};

export async function historyReader(
  sessionKey: string,
  method: "chat.history" | "chat.startup" = "chat.history",
) {
  const context = await createHistoryReadContext();
  const handler = expectDefined(chatHistoryHandlers[method], "history handler");
  return async (params: HistoryRequest, options: HistoryReadOptions = {}): Promise<HistoryPage> => {
    let result: HistoryPage | undefined;
    await handler({
      params: { sessionKey, ...params },
      context,
      req: { type: "req", id: randomUUID(), method },
      client: null,
      ...(options.acceptsSerializedJson ? { acceptsSerializedJson: true } : {}),
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

export async function withImportedHistory(
  method: "chat.history" | "chat.startup",
  importedCount: number,
  text: string,
  run: (fixture: {
    read: (params: HistoryRequest, options?: HistoryReadOptions) => Promise<HistoryPage>;
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
