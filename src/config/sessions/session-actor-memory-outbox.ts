import type {
  AcceptedContextEngineTurnOutboxPayload,
  ContextEngineTurnOutboxFilter,
  ContextEngineTurnOutboxPayload,
} from "../../agents/harness/context-engine-turn-outbox.js";
import { readSessionActorMemoryClosedTurn } from "./session-actor-memory-closed-turn.js";
import type {
  SessionActorMemoryOutboxRow,
  SessionActorMemorySideEffectsCommand,
  SessionActorMemorySideEffectsQuery,
} from "./session-actor-memory-side-effects-contract.js";
import { resolveSessionActorMemoryWindow } from "./session-actor-memory-state.js";
import type { SessionActorMemoryStorageContext } from "./session-actor-memory-storage-context.js";

type Query = Extract<SessionActorMemorySideEffectsQuery, { type: `session.outbox.${string}` }>;
type Command = Extract<SessionActorMemorySideEffectsCommand, { type: `session.outbox.${string}` }>;

function matches(row: SessionActorMemoryOutboxRow, filter: ContextEngineTurnOutboxFilter) {
  return row.engineId === filter.engineId && row.ownerPluginId === filter.ownerPluginId;
}

function pendingRows(
  context: SessionActorMemoryStorageContext,
  filter: ContextEngineTurnOutboxFilter & { sessionId?: string },
) {
  return [...context.state.outbox].filter(
    ([, row]) =>
      matches(row, filter) &&
      (!filter.sessionId || row.sessionId === filter.sessionId) &&
      row.payload.state !== "blocked",
  );
}

export function readSessionActorMemoryOutbox(
  context: SessionActorMemoryStorageContext,
  query: Query,
) {
  const rows = pendingRows(context, query.input);
  switch (query.type) {
    case "session.outbox.listPendingSessions":
      return [...new Set(rows.map(([, row]) => row.sessionId))].slice(
        0,
        Math.max(0, query.input.limit),
      );
    case "session.outbox.readNextPending": {
      const first = rows[0];
      return (
        first && {
          advancement_key: first[0],
          payload_json: first[1].payloadJson,
          session_id: first[1].sessionId,
        }
      );
    }
    case "session.outbox.hasPending":
      return rows.length > 0;
  }
  throw new Error("Unsupported memory outbox query");
}

function writePayload(
  context: SessionActorMemoryStorageContext,
  filter: ContextEngineTurnOutboxFilter,
  payload: ContextEngineTurnOutboxPayload,
) {
  const admission = payload.state === "admitted" ? payload.admission : payload.boundary.admission;
  if (
    admission.agentId !== context.agentId ||
    admission.storePath !== context.path ||
    admission.sessionKey !== context.state.hot.target.sessionKey ||
    !resolveSessionActorMemoryWindow(context.state, admission.sessionId)
  ) {
    throw new Error("Outbox intent does not belong to this session actor");
  }
  const key = admission.logicalTurnId;
  const existing = context.state.outbox.get(key);
  const payloadJson = JSON.stringify(payload);
  if (existing) {
    if (!matches(existing, filter)) {
      throw new Error(`context-engine advancement key collision: ${key}`);
    }
    const prior = existing.payload;
    const transition =
      (payload.state === "accepted" &&
        prior.state === "admitted" &&
        prior.admission.entryId === admission.entryId) ||
      ((payload.state === "blocked" || payload.state === "ready") &&
        prior.state === "accepted" &&
        prior.boundary.admission.entryId === admission.entryId &&
        prior.boundary.terminal.entryId === payload.boundary.terminal.entryId);
    if (!transition) {
      if (existing.payloadJson !== payloadJson) {
        throw new Error(`context-engine advancement key collision: ${key}`);
      }
      return;
    }
  }
  context.state.outbox.set(key, {
    engineId: filter.engineId,
    ownerPluginId: filter.ownerPluginId,
    sessionId: admission.sessionId,
    payload,
    payloadJson,
    attempts: 0,
  });
}

function advance(
  context: SessionActorMemoryStorageContext,
  filter: ContextEngineTurnOutboxFilter,
  payload: Omit<AcceptedContextEngineTurnOutboxPayload, "state">,
  limits: { maxEvents: number; maxBytes: number },
) {
  const closed = readSessionActorMemoryClosedTurn(context, {
    ...limits,
    boundary: payload.boundary,
  });
  if (closed.kind === "ok") {
    writePayload(context, filter, { ...payload, state: "ready", messages: closed.messages });
  } else if (closed.kind !== "projection-unavailable") {
    writePayload(context, filter, {
      boundary: payload.boundary,
      state: "blocked",
      failure: closed.kind,
    });
  }
  return closed.kind;
}

export function mutateSessionActorMemoryOutbox(
  context: SessionActorMemoryStorageContext,
  command: Command,
) {
  switch (command.type) {
    case "session.outbox.complete":
      context.state.outbox.delete(command.input.advancementKey);
      return undefined;
    case "session.outbox.recordFailure": {
      const { advancementKey, attemptedAt, message } = command.input;
      const row = context.state.outbox.get(advancementKey);
      if (row) {
        context.state.outbox.set(advancementKey, {
          ...row,
          attempts: row.attempts + 1,
          lastAttemptAt: attemptedAt,
          lastError: message,
        });
      }
      return undefined;
    }
    case "session.outbox.enqueueIntent":
      writePayload(context, command.input, {
        admission: command.input.admission,
        state: "admitted",
      });
      return undefined;
    case "session.outbox.acceptIntent":
      writePayload(context, command.input, {
        boundary: command.input.boundary,
        runtimeContext: command.input.runtimeContext,
        state: "accepted",
      });
      return undefined;
    case "session.outbox.publishClosedTurn":
      return advance(
        context,
        command.input,
        {
          boundary: command.input.boundary,
          runtimeContext: command.input.runtimeContext,
        },
        command.input,
      );
    case "session.outbox.discardIntent": {
      const row = context.state.outbox.get(command.input.admission.logicalTurnId);
      return Boolean(
        row &&
        matches(row, command.input) &&
        row.payload.state === "admitted" &&
        context.state.outbox.delete(command.input.admission.logicalTurnId),
      );
    }
    case "session.outbox.prepareRun": {
      const warnings: string[] = [];
      let pending = false;
      for (const [key, row] of context.state.outbox) {
        if (!matches(row, command.input) || row.sessionId !== command.input.sessionId) {
          continue;
        }
        const payload = row.payload;
        if (payload.state === "ready") {
          pending = true;
        } else if (payload.state === "blocked") {
          warnings.push(
            `[context-engine] durable turn advancement is blocked: ${key}: transcript range is ${payload.failure}`,
          );
        } else if (payload.state === "admitted") {
          context.state.outbox.delete(key);
          warnings.push(
            `[context-engine] discarded unaccepted turn advancement: ${key}: recovery found no host acceptance`,
          );
        } else {
          const result = advance(context, command.input, payload, {
            maxEvents: 20_000,
            maxBytes: 8 * 1024 * 1024,
          });
          pending ||= result === "ok" || result === "projection-unavailable";
          if (result !== "ok") {
            warnings.push(
              `[context-engine] blocked unrecoverable turn advancement: ${key}: transcript range is ${result}`,
            );
          }
        }
      }
      if (pending || !command.input.admission) {
        return { warnings, pending, admitted: false };
      }
      writePayload(context, command.input, {
        admission: command.input.admission,
        state: "admitted",
      });
      return { warnings, pending, admitted: true };
    }
  }
  throw new Error("Unsupported memory outbox command");
}
