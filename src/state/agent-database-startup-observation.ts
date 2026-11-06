import { GATEWAY_STARTUP_ADMISSION_WAIT_MS } from "../../packages/gateway-protocol/src/startup-unavailable.js";
import { raceWithTimeout } from "../../packages/retry/src/index.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { normalizeAgentId } from "../routing/session-key.js";
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
  return {
    get hasPendingAgents() {
      return pendingAgents.size > 0;
    },
    isAgentInputRecoveryPending(agentId) {
      return pendingAgents.get(normalizeAgentId(agentId))?.inputReady !== undefined;
    },
    /** Join only the current agent preparation, without holding channel startup or healthy agents. */
    waitForAgentPreparation(
      agentId: string,
      options: {
        env?: NodeJS.ProcessEnv;
        signal?: AbortSignal;
        forWrite?: boolean;
        forInput?: boolean;
      } = {},
    ): Promise<void> | undefined {
      const pending = pendingAgents.get(normalizeAgentId(agentId));
      if (
        !pending ||
        (readAgentDatabaseAdmissionRefusal(agentId, options) !== pending.refusal &&
          !(options.forInput && pending.inputReady))
      ) {
        return undefined;
      }
      const signal = options.signal ? AbortSignal.any([lifetime, options.signal]) : lifetime;
      if (
        options.forInput &&
        readAgentDatabaseAdmissionRefusal(agentId, options) !== pending.refusal
      ) {
        return pending.inputReady && racePromiseWithAbortSignal(pending.inputReady, signal);
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
        return options.forInput && pending.inputReady
          ? racePromiseWithAbortSignal(pending.inputReady, signal)
          : undefined;
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
