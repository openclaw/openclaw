import type { HeartbeatOutcomeRow } from "../../infra/heartbeat-outcome-store.kernel.js";
import {
  mutateSessionActorMemoryOutbox,
  readSessionActorMemoryOutbox,
} from "./session-actor-memory-outbox.js";
import type {
  SessionActorMemorySideEffectsCommand,
  SessionActorMemorySideEffectsQuery,
} from "./session-actor-memory-side-effects-contract.js";
import type { SessionActorMemoryStorageContext } from "./session-actor-memory-storage-context.js";
import {
  appendSessionActorMemoryTrajectory,
  readSessionActorMemoryTrajectoryRows,
} from "./session-actor-memory-trajectory.js";

export function readSessionActorMemorySideEffects(
  context: SessionActorMemoryStorageContext,
  query: SessionActorMemorySideEffectsQuery,
) {
  if (query.type === "session.trajectory.read") {
    return readSessionActorMemoryTrajectoryRows(context, query.input).map(({ event }) => event);
  }
  if (query.type === "session.trajectory.rows") {
    return readSessionActorMemoryTrajectoryRows(context, query.input);
  }
  return readSessionActorMemoryOutbox(context, query);
}

export function mutateSessionActorMemorySideEffects(
  context: SessionActorMemoryStorageContext,
  command: SessionActorMemorySideEffectsCommand,
) {
  const key = context.state.hot.target.sessionKey;
  switch (command.type) {
    case "session.heartbeat.persist": {
      if (command.input.session_key !== key) {
        throw new Error("Heartbeat outcome does not target this session actor");
      }
      if (context.state.hot.entry) {
        const row: HeartbeatOutcomeRow = {
          ...command.input,
          next_check: command.input.next_check ?? null,
          priority: command.input.priority ?? null,
          response_reason: command.input.response_reason ?? null,
          task_names_json: command.input.task_names_json ?? null,
          wake_reason: command.input.wake_reason ?? null,
          wake_source: command.input.wake_source ?? null,
          context_run_id: null,
          context_claimed_at: null,
        };
        context.state.heartbeatOutcome = row;
      }
      return undefined;
    }
    case "session.heartbeat.claim": {
      if (command.input.sessionKey !== key) {
        throw new Error("Heartbeat outcome does not target this session actor");
      }
      const row = context.state.heartbeatOutcome;
      if (!row || (row.context_run_id !== null && row.context_run_id !== command.input.runId)) {
        return undefined;
      }
      const claimed = {
        ...row,
        context_run_id: command.input.runId,
        context_claimed_at: row.context_claimed_at ?? Date.now(),
      };
      context.state.heartbeatOutcome = claimed;
      return claimed;
    }
    case "session.messageToolOutcome.record": {
      if (command.input.session_key !== key || command.input.agent_id !== context.agentId) {
        throw new Error("Message-tool outcome does not target this session actor");
      }
      const all = [...context.entries()].flatMap(([sessionKey, state]) =>
        state.messageToolOutcomes.map((row) => ({ sessionKey, row })),
      );
      const id = all.reduce((max, { row }) => Math.max(max, row.id), 0) + 1;
      const row = { ...command.input, id };
      context.state.messageToolOutcomes.push(row);
      all.push({ sessionKey: key, row });
      all.sort((a, b) => b.row.occurred_at - a.row.occurred_at || b.row.id - a.row.id);
      for (const removed of all.slice(10_000)) {
        const state = context.edit(removed.sessionKey);
        state.messageToolOutcomes = state.messageToolOutcomes.filter(
          (item) => item.id !== removed.row.id,
        );
      }
      return undefined;
    }
    case "session.trajectory.append":
      return appendSessionActorMemoryTrajectory(context, command.input);
    default:
      return mutateSessionActorMemoryOutbox(context, command);
  }
}
