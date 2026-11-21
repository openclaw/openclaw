import { randomUUID } from "node:crypto";
import {
  validateAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";

/**
 * Server-owned current-policy assertion for a signed wire Full Access grant.
 *
 * A delegated change may only be applied automatically when the submitting run can
 * still assert, at decision time, that automatic changes remain authorized by live
 * policy. In-process callers supply that closure directly through the admitted run
 * identity. Wire (CLI-backend) callers cross a process boundary, so the closure is
 * handed over out of band: the preparing host registers it here and the signed token
 * carries only an opaque correlation id. The id is never authority; redemption
 * requires the exact same agent, session, operational run instance and delegated
 * authority claim that the signed token verified on admission.
 *
 * A missing or unbound handoff leaves the decision to a human. This module never
 * widens permission on its own and never weakens #196984's gates.
 */

const AGENT_RUNTIME_AUTOMATIC_CHANGE_POLICY = Symbol("agentRuntimeAutomaticChangePolicyAssertion");

const POLICY_HANDOFF_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_POLICY_HANDOFFS = 256;

/** Re-runs the authoritative policy closure; throws when a human must decide. */
export type AgentRuntimeAutomaticChangePolicyAssertion = () => void;

type AgentRuntimeAutomaticChangePolicyCarrier = {
  [AGENT_RUNTIME_AUTOMATIC_CHANGE_POLICY]?: AgentRuntimeAutomaticChangePolicyAssertion;
};

type AutomaticChangePolicyHandoff = Readonly<{
  agentId: string;
  sessionKey: string;
  operationalRunInstance: Readonly<{ instanceId: string; runId: string }>;
  delegatedAuthority: AgentRunDelegatedAuthority;
  assertion: AgentRuntimeAutomaticChangePolicyAssertion;
  expiresAtMs: number;
}>;

const automaticChangePolicyHandoffs = resolveGlobalMap<string, AutomaticChangePolicyHandoff>(
  Symbol.for("openclaw.agentRuntimeAutomaticChangePolicyHandoffs"),
  (handoffs) => handoffs.clear(),
);

function sameOperationalRunInstance(
  left: Readonly<{ instanceId: string; runId: string }>,
  right: Readonly<{ instanceId: string; runId: string }>,
): boolean {
  return left.instanceId === right.instanceId && left.runId === right.runId;
}

function pruneAutomaticChangePolicyHandoffs(nowMs: number): void {
  for (const [id, handoff] of automaticChangePolicyHandoffs) {
    if (
      handoff.expiresAtMs <= nowMs ||
      !validateAgentRunDelegatedAuthority(handoff.delegatedAuthority)
    ) {
      automaticChangePolicyHandoffs.delete(id);
    }
  }
  // Reserve one slot for the new handoff after retiring stale entries.
  pruneMapToMaxSize(automaticChangePolicyHandoffs, MAX_POLICY_HANDOFFS - 1);
}

/**
 * Register the host-owned closure for the exact run that is about to be signed.
 * The returned id is opaque correlation only; it carries no authority on the wire.
 */
export function createAgentRuntimeAutomaticChangePolicyHandoff(params: {
  agentId: string;
  sessionKey: string;
  operationalRunInstance: Readonly<{ instanceId: string; runId: string }>;
  delegatedAuthority: AgentRunDelegatedAuthority;
  assertion: AgentRuntimeAutomaticChangePolicyAssertion;
}): Readonly<{ id: string; revoke: () => void }> | undefined {
  if (!validateAgentRunDelegatedAuthority(params.delegatedAuthority)) {
    return undefined;
  }
  if (
    !sameOperationalRunInstance(
      params.operationalRunInstance,
      params.delegatedAuthority.operationalRunInstance,
    )
  ) {
    throw new Error("automatic change policy handoff disagrees with its parent admission");
  }
  const nowMs = Date.now();
  pruneAutomaticChangePolicyHandoffs(nowMs);
  const id = randomUUID();
  automaticChangePolicyHandoffs.set(
    id,
    Object.freeze({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      operationalRunInstance: params.operationalRunInstance,
      delegatedAuthority: params.delegatedAuthority,
      assertion: params.assertion,
      expiresAtMs: nowMs + POLICY_HANDOFF_TTL_MS,
    }),
  );
  return Object.freeze({
    id,
    revoke: () => {
      automaticChangePolicyHandoffs.delete(id);
    },
  });
}

/**
 * Redeem the host-owned closure for the exact signed owner verified on admission.
 * Undefined means no automatic decision is available and a human must decide.
 */
export function redeemAgentRuntimeAutomaticChangePolicyHandoff(params: {
  id: string;
  agentId: string;
  sessionKey: string;
  operationalRunInstance: Readonly<{ instanceId: string; runId: string }>;
  delegatedAuthority: AgentRunDelegatedAuthority;
}): AgentRuntimeAutomaticChangePolicyAssertion | undefined {
  const handoff = automaticChangePolicyHandoffs.get(params.id);
  if (
    !handoff ||
    handoff.expiresAtMs <= Date.now() ||
    handoff.agentId !== params.agentId ||
    handoff.sessionKey !== params.sessionKey ||
    !sameOperationalRunInstance(handoff.operationalRunInstance, params.operationalRunInstance) ||
    handoff.delegatedAuthority.claimId !== params.delegatedAuthority.claimId ||
    handoff.delegatedAuthority.lifecycleGeneration !==
      params.delegatedAuthority.lifecycleGeneration ||
    !validateAgentRunDelegatedAuthority(handoff.delegatedAuthority)
  ) {
    // A mismatched id is still a consumed correlation id; do not let it linger.
    automaticChangePolicyHandoffs.delete(params.id);
    return undefined;
  }
  // Reusable while its exact authority stays live: every call re-reads live policy.
  return handoff.assertion;
}

/** Attach the redeemed closure in-process; never parsed from client input or token JSON. */
export function withAgentRuntimeAutomaticChangePolicyAssertion<T extends object>(
  identity: T,
  assertion: AgentRuntimeAutomaticChangePolicyAssertion,
): T & AgentRuntimeAutomaticChangePolicyCarrier {
  return { ...identity, [AGENT_RUNTIME_AUTOMATIC_CHANGE_POLICY]: assertion };
}

export function readAgentRuntimeAutomaticChangePolicyAssertion(
  identity: object,
): AgentRuntimeAutomaticChangePolicyAssertion | undefined {
  return (identity as AgentRuntimeAutomaticChangePolicyCarrier)[
    AGENT_RUNTIME_AUTOMATIC_CHANGE_POLICY
  ];
}
