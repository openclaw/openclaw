import { raceWithTimeout } from "../../packages/retry/src/index.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../sessions/session-key-utils.js";
import {
  AgentDatabaseAdmissionError,
  assertAgentDatabaseAdmitted,
  readAgentDatabaseAdmissionRefusal,
} from "./agent-database-admission.js";
import type { AgentDatabasePreparation } from "./agent-database-preparation-context.js";
import type { PendingAgentDatabaseRecovery } from "./agent-database-startup.types.js";

/** Observe the startup owner's current work without exposing its lifecycle or write borrow. */
export function createAgentDatabaseStartupObservation(
  pendingAgents: ReadonlyMap<string, PendingAgentDatabaseRecovery>,
  lifetime: AbortSignal,
  observePreparedIntegrity?: AgentDatabasePreparation["observePreparedIntegrity"],
): AgentDatabasePreparation {
  const inputs = new Map<
    string,
    { sessions: ReadonlyMap<string, Promise<void>>; completion: Promise<void> }
  >();
  return {
    observePreparedIntegrity,
    get hasPendingAgents() {
      return pendingAgents.size > 0 || inputs.size > 0;
    },
    registerInputRecovery(agentId, recovery) {
      const key = normalizeAgentId(agentId);
      inputs.set(key, recovery);
      const retire = () => {
        if (inputs.get(key) === recovery) {
          inputs.delete(key);
        }
      };
      void recovery.completion.then(retire, retire);
    },
    isAgentInputRecoveryPending(agentId) {
      return inputs.has(normalizeAgentId(agentId));
    },
    /** Join only the current agent preparation, without holding channel startup or healthy agents. */
    waitForAgentPreparation(agentId, options = {}) {
      const key = normalizeAgentId(agentId);
      const pending = pendingAgents.get(key);
      if (!pending && !options.forInput) {
        return undefined;
      }
      const signal = options.signal ? AbortSignal.any([lifetime, options.signal]) : lifetime;
      const waitForInputs = () => {
        const recovery = options.forInput ? inputs.get(key) : undefined;
        const selected = options.sessionKey
          ? recovery?.sessions.get(normalizeSessionKeyPreservingOpaquePeerIds(options.sessionKey))
          : recovery?.completion;
        return selected && recovery
          ? racePromiseWithAbortSignal(
              selected === recovery.completion
                ? selected
                : Promise.race([selected, recovery.completion]),
              signal,
            )
          : undefined;
      };
      if (!pending || readAgentDatabaseAdmissionRefusal(agentId, options) !== pending.refusal) {
        return waitForInputs();
      }
      if (!options.forWrite) {
        const readiness =
          options.forWrite === false && !options.forInput ? pending.readReady : pending.completion;
        return readiness && racePromiseWithAbortSignal(readiness, signal).then(waitForInputs);
      }
      // Bound the caller's wait without cancelling the Gateway's preparation or native authority.
      return raceWithTimeout(
        pending.completion,
        1_000,
        () => {
          throw new AgentDatabaseAdmissionError({
            ...pending.refusal,
            repairHint:
              "Agent database verification and preparation in progress. Retry the request shortly.",
          });
        },
        { signal, ref: false },
      ).then(() => {
        assertAgentDatabaseAdmitted(agentId, options);
        return waitForInputs();
      });
    },
  };
}

export function recoveryTiming(recovery: PendingAgentDatabaseRecovery, now = performance.now()) {
  return {
    elapsedMs: Math.round(now - recovery.startedAt),
    phaseDurationsMs: {
      ...recovery.phaseDurationsMs,
      [recovery.phase]: Math.round(
        (recovery.phaseDurationsMs[recovery.phase] ?? 0) + now - recovery.phaseStartedAt,
      ),
    },
  };
}

export function startAgentDatabasePreparationProgress(
  pending: ReadonlyMap<string, PendingAgentDatabaseRecovery>,
  publishingAgentId: () => string | undefined,
) {
  const timer = setInterval(() => {
    const now = performance.now();
    for (const [agentId, recovery] of pending) {
      createSubsystemLogger("state/agent-admission").warn(
        "agent database startup preparation still running",
        {
          agentId,
          phase: recovery.phase,
          elapsedMs: Math.round(now - recovery.startedAt),
          phaseElapsedMs: Math.round(now - recovery.phaseStartedAt),
          ...(recovery.phase === "publication-wait"
            ? { publishingAgentId: publishingAgentId() }
            : {}),
        },
      );
    }
  }, 60_000);
  timer.unref();
  return timer;
}
