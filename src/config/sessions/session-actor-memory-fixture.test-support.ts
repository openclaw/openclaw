import { afterEach, assert, expect } from "vitest";
import type { BoundAgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import type { SessionActorAuthority, SessionActorStorage } from "./session-actor-contract.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { memoryStorage } from "./session-actor-memory-publication.test-support.js";
import { createMemorySessionActorOwner } from "./session-actor-memory.js";
import { acquireSessionActorStorage } from "./session-actor-storage-binding.js";
import type { SessionMetadataOperations } from "./session-manager-write-contract.js";
import type { SessionTurnPlan } from "./session-turn.types.js";
import type { InternalSessionEntry } from "./types.js";

export const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
export const lifetime = { assertCurrent() {}, assertReadable() {} };
export const timestamp = "2026-10-11T00:00:00.000Z";
type Scope = BoundAgentRunSessionTarget & { env?: NodeJS.ProcessEnv };
type Append = SessionMetadataOperations["session.metadata.append"]["input"];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) {
    close();
  }
});

export async function expectMatch(result: Promise<unknown>, expected: unknown) {
  expect(await result).toMatchObject(expected);
}

export async function expectEqual(result: Promise<unknown>, expected: unknown) {
  expect(await result).toEqual(expected);
}

export function header(id: string, time = timestamp) {
  return { type: "session", version: 3, id, timestamp: time, cwd: "/synthetic" };
}

export function messageEvent<Message extends object>(
  id: string,
  parentId: string | null,
  payload: Message,
  time = timestamp,
) {
  return { type: "message" as const, id, parentId, timestamp: time, message: payload };
}

export function message(
  id: string,
  parentId: string | null,
  role: string,
  content: unknown,
  extra: Record<string, unknown> = {},
) {
  return messageEvent(id, parentId, { role, content, ...extra });
}

export const toolCall = (id: string, parentId: string, extra: Record<string, unknown> = {}) =>
  message(
    id,
    parentId,
    "assistant",
    [{ type: "toolCall", id: "call", name: "lookup", arguments: {} }],
    extra,
  );

export const toolResult = (
  id: string,
  parentId: string,
  text: string,
  extra: Record<string, unknown> = {},
) =>
  message(id, parentId, "toolResult", [{ type: "text", text }], {
    toolCallId: "call",
    toolName: "lookup",
    isError: false,
    ...extra,
  });

export function appendMemoryMessage(
  storage: SessionActorStorage,
  scope: Scope,
  event: ReturnType<typeof messageEvent>,
  options: Append["options"] = {},
) {
  const { message: payload, ...envelope } = event;
  return memoryStorage(storage).commit("session.metadata.append", {
    scope,
    event: envelope,
    options,
    message: { messageJson: JSON.stringify(payload), cwd: "/synthetic", validateTurn: false },
  });
}

export async function memoryBinding(scope: Scope) {
  const { sessionId: _sessionId, ...target } = scope;
  cleanups.push(() =>
    memorySessionActorOwners.closeDatabase({ agentId: scope.agentId, path: scope.storePath }),
  );
  const binding = await acquireSessionActorStorage(target, { authority, lifetime, create: true });
  assert(binding, "Memory creation did not select the actor");
  const actor = binding.actor;
  const storage = actor.storage;
  return { actor, storage, ...memoryStorage(storage) };
}

export async function memoryFixture(scope: Scope, registered = false) {
  const identity = { agentId: scope.agentId, path: scope.storePath };
  const owner = registered
    ? memorySessionActorOwners.get(identity)
    : createMemorySessionActorOwner(identity);
  cleanups.push(() =>
    registered ? memorySessionActorOwners.closeDatabase(identity) : owner.close(),
  );
  const acquire = async (sessionKey = scope.sessionKey) => {
    const actor = await owner.acquire({ database: owner.identity, sessionKey }, lifetime);
    const storage = actor.storage;
    assert(storage, "Expected memory storage");
    const api = memoryStorage(storage);
    const appendRaw = (event: Append["event"], options: Append["options"] = {}) =>
      api.commit("session.metadata.append", { scope: { ...scope, sessionKey }, event, options });
    return {
      actor,
      storage,
      ...api,
      initialize: (entry: InternalSessionEntry) =>
        api.commit("session.metadata.initialize", { scope, entry }),
      async hydrate(sessionId?: string) {
        const result = await api.read("session.history.hydrate", { sessionId });
        assert(result.kind === "full", "Expected full memory history");
        return result.snapshot;
      },
      appendRaw,
      appendMessage(event: ReturnType<typeof messageEvent>, options: Append["options"] = {}) {
        return appendMemoryMessage(storage, { ...scope, sessionKey }, event, options);
      },
      phase(
        commandId: string,
        messages: SessionTurnPlan["options"]["messages"],
        sessionFile = sessionKey,
      ) {
        return actor.appendToolResult(
          {
            commandId,
            phaseId: "turn",
            turn: {
              agentId: scope.agentId,
              sessionKey,
              options: { expectedSessionId: scope.sessionId, sessionFile, messages },
            },
          },
          authority,
        );
      },
    };
  };
  return { ...(await acquire()), acquire };
}
