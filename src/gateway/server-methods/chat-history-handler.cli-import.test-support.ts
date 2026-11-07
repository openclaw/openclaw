import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ChatHistoryParams } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { captureRuntimeConfigAsyncReader } from "../../config/config.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { historyPayload, historyRpc } from "./chat-history-fixture.test-support.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";

export type HistoryPage = {
  messages: unknown[];
  hasMore?: boolean;
  nextOffset?: number;
  offset?: number;
  olderCursor?: string;
  newerCursor?: string;
  totalMessages?: number;
  windowReset?: boolean;
};

export type HistoryRequest = Omit<ChatHistoryParams, "sessionKey">;

export function appendLocal(
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

export async function seedCliHistory(
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

export function cliMessage(
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

export function writeCliRows(sourcePath: string, rows: unknown[]) {
  return fs.writeFile(sourcePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

async function rpcReader(
  sessionKey: string,
  method: "chat.history" | "chat.startup" | "chat.message.get",
) {
  const request = historyRpc(await createHistoryReadContext(), sessionKey);
  return async (params: HistoryRequest) => historyPayload(await request(method, params));
}

export async function historyReader(
  sessionKey: string,
  method: "chat.history" | "chat.startup" = "chat.history",
) {
  const read = await rpcReader(sessionKey, method);
  return async (params: HistoryRequest) => (await read(params)) as HistoryPage;
}

export async function messageReader(sessionKey: string) {
  const read = await rpcReader(sessionKey, "chat.message.get");
  return (messageId: string) => read({ messageId });
}

export async function withImportedHistory(
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
