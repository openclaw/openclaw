import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { listAgentIds } from "../agents/agent-scope.js";
import type { RequesterOrigin } from "../agents/requester-origin.js";
import { resolveRequesterSpawnTargetPolicy } from "../agents/subagents/spawn/subagent-target-policy.js";
import { readMessageClientSources } from "../chat/message-client-source.js";
import { readSessionSubmittedInput } from "../config/sessions/session-accessor.pending-inputs.js";
import type { SessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { GatewayOperatorRecoveryAuthorizationError } from "../infra/restart-recovery-errors.js";
import { isSubagentSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";

/** A delegated turn retains its exact parent, not merely the child's saved sender identity. */
export async function prepareRestartRecoveryParentSource(params: {
  entry: InternalSessionEntry;
  target: { agentId: string; sessionKey: string };
  requesterOrigin: RequesterOrigin | undefined;
  operatorSource?: {
    authority: AdmittedRunOperatorAuthority;
    storePath: string;
    sourceRunId: string;
  };
  context: GatewayRequestContext;
  assertCurrent: () => void;
}): Promise<
  { source: SessionSourceAssertion & { retain: () => () => void }; release: () => void } | undefined
> {
  const parentSessionKey = params.entry.spawnedBy;
  // A fresh human turn in the child has its own operator source and needs no old parent.
  if (
    !(
      parentSessionKey ||
      params.entry.subagentRole ||
      (params.entry.spawnDepth ?? 0) > 0 ||
      isSubagentSessionKey(params.target.sessionKey)
    ) ||
    (params.requesterOrigin?.sessionKey === params.target.sessionKey &&
      (params.entry.restartRecoverySourceIngress === "channel" ||
        params.entry.restartRecoverySourceIngress === "control-ui"))
  ) {
    return undefined;
  }
  const operatorSource = params.operatorSource;
  if (
    operatorSource &&
    params.requesterOrigin?.sessionKey === params.target.sessionKey &&
    params.requesterOrigin.operatorProfileId === operatorSource.authority.profileId
  ) {
    // TUI inputs use internal ingress; synthetic continuations can also have self-origin.
    operatorSource.authority.assertCurrent();
    const input = await readSessionSubmittedInput(
      {
        ...params.target,
        sessionId: params.entry.sessionId,
        storePath: operatorSource.storePath,
      },
      `${operatorSource.sourceRunId}:user`,
    );
    params.assertCurrent();
    operatorSource.authority.assertCurrent();
    // Direct inputs can omit provenance while retaining their host-captured client source.
    if (
      input?.provenance?.kind === "external_user" ||
      (input?.provenance === undefined && readMessageClientSources(input).length > 0)
    ) {
      return undefined;
    }
  }
  const parentAgentId = parentSessionKey
    ? parseAgentSessionKey(parentSessionKey)?.agentId
    : undefined;
  const parentSessionId = params.entry.spawnedBySessionId;
  if (
    !parentSessionKey ||
    !parentAgentId ||
    !parentSessionId ||
    !params.entry.parentSessionLifecycleRevision
  ) {
    throw new GatewayOperatorRecoveryAuthorizationError(
      "Restart recovery cannot restore the original parent session authority.",
    );
  }
  const facts = await prepareSessionMutationFacts({
    cfg: params.context.getRuntimeConfig(),
    agentId: parentAgentId,
    sessionKey: parentSessionKey,
    allowMissing: true,
  });
  let references = 1;
  const release = () => {
    if (--references === 0) {
      facts.release();
    }
  };
  const assertParentCurrent = () => {
    if (references === 0) {
      throw new GatewayOperatorRecoveryAuthorizationError(
        "Restart recovery parent authority closed.",
      );
    }
    const cfg = params.context.getRuntimeConfig();
    const parent = facts.readCurrent(cfg).target;
    if (
      parent?.entry.sessionId !== parentSessionId ||
      parent.entry.lifecycleRevision !== params.entry.parentSessionLifecycleRevision ||
      parent.entry.archivedAt !== undefined
    ) {
      throw new GatewayOperatorRecoveryAuthorizationError(
        "Restart recovery parent session was removed, archived, or replaced.",
      );
    }
    if (parentAgentId === params.target.agentId) {
      return;
    }
    const policy = resolveRequesterSpawnTargetPolicy({
      cfg,
      requesterAgentId: parentAgentId,
      targetAgentId: params.target.agentId,
      requestedAgentId: params.target.agentId,
      configuredAgentIds: listAgentIds(cfg),
    });
    if (!policy.ok) {
      throw new GatewayOperatorRecoveryAuthorizationError(policy.error);
    }
  };
  try {
    params.assertCurrent();
    assertParentCurrent();
    const source = Object.assign(assertParentCurrent, {
      retain: () => {
        assertParentCurrent();
        references++;
        let retained = true;
        return () => {
          if (retained) {
            retained = false;
            release();
          }
        };
      },
    });
    return { source, release };
  } catch (error) {
    release();
    throw error;
  }
}
