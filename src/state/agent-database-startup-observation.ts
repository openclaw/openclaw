import { GATEWAY_STARTUP_ADMISSION_WAIT_MS } from "../../packages/gateway-protocol/src/startup-unavailable.js";
import { raceWithTimeout } from "../../packages/retry/src/index.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../sessions/session-key-utils.js";
import {
  AgentDatabaseAdmissionError,
  assertAgentDatabaseAdmitted,
  readAgentDatabaseAdmissionRefusal,
} from "./agent-database-admission.js";
import type { AgentDatabasePreparation } from "./agent-database-preparation-context.js";
import type { PendingAgentDatabaseRecovery } from "./agent-database-startup.types.js";
import { AGENT_DATABASE_PREFLIGHT_CONCURRENCY } from "./openclaw-agent-db-contract.js";

/** Observe the startup owner's current work without exposing its lifecycle or write borrow. */
export function createAgentDatabaseStartupObservation(
  pendingAgents: ReadonlyMap<string, PendingAgentDatabaseRecovery>,
  lifetime: AbortSignal,
): AgentDatabasePreparation {
  const inputs = new Map<
    string,
    { sessions: ReadonlyMap<string, Promise<void>>; completion: Promise<void> }
  >();
  return {
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
      if (!options.forWrite && !options.forInput) {
        const readiness = options.forWrite === false ? pending.readReady : pending.completion;
        return readiness && racePromiseWithAbortSignal(readiness, signal);
      }
      // Allow five minutes for slow-host startup, plus a minute per queued inspection batch.
      const timeoutMs =
        GATEWAY_STARTUP_ADMISSION_WAIT_MS +
        Math.ceil(pendingAgents.size / AGENT_DATABASE_PREFLIGHT_CONCURRENCY) * 60_000;
      return raceWithTimeout(
        pending.completion,
        timeoutMs,
        () => {
          throw new AgentDatabaseAdmissionError({
            ...pending.refusal,
            repairHint:
              "This agent is still preparing. Retry the request after background inspection and preparation finish.",
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
