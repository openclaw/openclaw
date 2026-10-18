import { createAgentRunDirectAbortError } from "../agents/run-termination.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  agentWorkAdmissionIdentity,
  matchesAgentWorkAdmission,
  sessionWorkAdmissionClosures,
  type AgentWorkAdmissionTarget,
} from "./session-agent-work-admission.js";
import type { Effect } from "./session-controller.contracts.js";
import {
  allEffects,
  collectSessionControllerTargets,
} from "./session-controller.lifecycle-projections.js";
import { ownerContext } from "./session-controller.owner-context.js";
import { sessionControllers } from "./session-controller.storage.js";

function agentEffects(target: AgentWorkAdmissionTarget): Set<Effect> {
  const agent = agentWorkAdmissionIdentity(target);
  return new Set(
    [...allEffects()].filter((effect) => matchesAgentWorkAdmission(effect.agent, agent)),
  );
}

/** Agent deletion closes the same effect admission used by session mutations. */
export function assertAgentControllerAdmissionOpen(effect: Effect): void {
  for (const closure of sessionWorkAdmissionClosures) {
    if (closure.agent && matchesAgentWorkAdmission(closure.agent, effect.agent)) {
      throw closure.reason;
    }
  }
}

export function closeAgentWorkAdmissions(
  params: AgentWorkAdmissionTarget & { reason: Error },
): () => void {
  const agent = agentWorkAdmissionIdentity(params);
  const current = ownerContext.getStore();
  if (
    [...(current?.effects ?? [])].some((effect) => matchesAgentWorkAdmission(effect.agent, agent))
  ) {
    throw new Error("Cannot delete an agent from its own active turn.");
  }
  const closure = { agent, identities: [], reason: params.reason };
  sessionWorkAdmissionClosures.add(closure);
  try {
    for (const effect of agentEffects(params)) {
      if (effect.phase === "queued" || effect.phase === "validating") {
        effect.interrupted ??= params.reason;
        effect.cancel.abort(effect.interrupted);
        effect.interrupt?.(effect.interrupted);
      }
    }
  } catch (error) {
    sessionWorkAdmissionClosures.delete(closure);
    throw error;
  }
  return () => {
    sessionWorkAdmissionClosures.delete(closure);
  };
}

export function collectActiveAgentSessionWorkAdmissions(
  target: AgentWorkAdmissionTarget,
): Map<string, Set<string>> {
  const agent = agentWorkAdmissionIdentity(target);
  const owners = new Set<object>(agentEffects(target));
  // Terminal slots may clear before their raw producer settles. Deletion must
  // still drain those exact retained operations, not only visible active runs.
  for (const entry of sessionControllers.values()) {
    for (const operation of entry.lifecycle?.operations ?? []) {
      const agentId = operation.agentId ?? entry.target?.agentId;
      if (agentId && normalizeAgentId(agentId) === agent.agentId) {
        owners.add(operation);
      }
    }
  }
  return collectSessionControllerTargets(owners);
}

export function startAgentWorkAdmissionInterruption(
  params: AgentWorkAdmissionTarget & { reason?: Error; assertCurrent?: () => void },
): { released: Promise<void>; interruptedRunIds: ReadonlySet<string> } {
  const effects = agentEffects(params);
  const current = ownerContext.getStore();
  const selected = [...effects].filter((effect) => !current?.effects.has(effect));
  const interruptedRunIds = new Set<string>();
  const failures: unknown[] = [];
  const settlements: Promise<void>[] = [];
  for (const effect of selected) {
    try {
      params.assertCurrent?.();
    } catch (error) {
      failures.push(error);
      break;
    }
    settlements.push(effect.ref.released);
    try {
      if (effect.interrupted) {
        continue;
      }
      effect.interrupted = params.reason ?? createAgentRunDirectAbortError();
      try {
        const receipt = effect.interrupt?.(effect.interrupted);
        if (receipt) {
          interruptedRunIds.add(receipt.runId);
        }
      } finally {
        effect.cancel.abort(effect.interrupted);
      }
    } catch (error) {
      failures.push(error);
    }
  }
  return {
    interruptedRunIds,
    released: Promise.all(settlements).then(() => {
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length) {
        throw new AggregateError(failures, "Agent work interruption failed");
      }
    }),
  };
}
