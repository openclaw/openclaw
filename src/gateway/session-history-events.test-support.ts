import path from "node:path";
import type { StatementSync } from "node:sqlite";
import { expect, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { SessionHistoryWorkerRequest } from "../config/sessions/session-history-types.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { readChatHistoryMessageId } from "./session-history-tail.js";

export function withHistoryState(run: (state: OpenClawTestState) => Promise<void>) {
  return withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setRuntimeConfigSnapshot({});
    await run(state);
  });
}

export function historyTarget(state: OpenClawTestState, sessionId: string) {
  return {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: path.join(state.sessionsDir(), "sessions.json"),
  };
}

type RpcParams = Extract<SessionHistoryWorkerRequest, { kind: "rpc" }>["params"];
export function historyParams(
  target: { agentId: string; sessionId: string; sessionKey: string; storePath: string },
  entry?: RpcParams["entry"],
): RpcParams {
  return {
    entry,
    provider: undefined,
    sessionId: target.sessionId,
    storePath: target.storePath,
    sessionAgentId: target.agentId,
    canonicalKey: target.sessionKey,
    max: 10,
    maxHistoryBytes: 100_000,
    effectiveMaxChars: 8000,
    offset: undefined,
    messageId: undefined,
  };
}

export function messageEvent(id: string, message: unknown, parentId: string | null = null) {
  return { type: "message", id, parentId, message };
}

export function expectMessageIds(messages: unknown[], ids: (string | undefined)[]) {
  expect(messages.map(readChatHistoryMessageId)).toEqual(ids);
}

export function observeHistorySql(database: EngineConnection, matches: (sql: string) => boolean) {
  const prototype: StatementSync = Object.getPrototypeOf(
    requireNativeSqliteDatabase(database).prepare("SELECT 1"),
  );
  const queries: string[] = [];
  const observers = (["all", "get", "iterate", "run"] as const).map((method) => {
    const observer = new Proxy(prototype[method], {
      apply(read, receiver: StatementSync, args) {
        if (matches(receiver.sourceSQL)) {
          queries.push(receiver.sourceSQL);
        }
        return Reflect.apply(read, receiver, args);
      },
    });
    return vi.spyOn(prototype, method).mockImplementation(observer);
  });
  return { queries, restore: () => observers.forEach((observer) => observer.mockRestore()) };
}
