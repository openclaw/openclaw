import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { intersectParticipationCeilings } from "../agents/participation-ceiling.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { retainGatewayOperatorInvocation } from "./operator-run-invocation.js";
import { decodeQueuedOperatorRecoverySource } from "./operator-run-recovery-source.codec.js";
import { restoreGatewayQueuedOperatorRecovery } from "./operator-run-recovery.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

export function readSessionDelegatedParticipation(entry: SessionEntry | undefined) {
  if (!entry?.delegatedOperatorSource) {
    return undefined;
  }
  const source = decodeQueuedOperatorRecoverySource(entry.delegatedOperatorSource);
  if (source.kind !== "gateway" || !source.snapshot.participationCeiling) {
    throw new Error("Delegated session requires its original participant source.");
  }
  return source.snapshot.participationCeiling;
}

/** Child turns restore immutable source custody through the same owner as queued and scheduled work. */
export async function prepareSessionDelegatedOperatorAuthority(params: {
  context?: GatewayRequestContext;
  agentId: string;
  entry?: SessionEntry;
  authority?: AdmittedRunOperatorAuthority;
  assertCurrent?: () => void;
}) {
  const ceiling = readSessionDelegatedParticipation(params.entry);
  if (!ceiling) {
    return undefined;
  }
  if (ceiling.source.agentId !== params.agentId) {
    throw new Error("Delegated session changed its original agent.");
  }
  intersectParticipationCeilings(ceiling, params.authority?.participationCeiling);
  const scope = getPluginRuntimeGatewayRequestScope();
  const context = params.context ?? scope?.resolveGatewayContext?.() ?? scope?.context;
  if (!context) {
    throw new Error("Delegated session requires its original Gateway.");
  }
  const restored = await restoreGatewayQueuedOperatorRecovery({
    source: params.entry!.delegatedOperatorSource!,
    context,
    assertCurrent: () => params.assertCurrent?.(),
  });
  if (!params.authority) {
    return restored;
  }
  let releaseOriginal: (() => void) | undefined;
  try {
    releaseOriginal = params.authority.retain?.();
    return retainGatewayOperatorInvocation(
      { authority: params.authority, release: () => releaseOriginal?.() },
      {
        participationAuthority: restored.authority,
        assertCurrent: () => restored.authority.signal?.throwIfAborted(),
        signal: restored.authority.signal,
        release: restored.release,
      },
    );
  } catch (error) {
    releaseOriginal?.();
    restored.release();
    throw error;
  }
}

/**
 * Selects participant custody for a system turn. When it returns custody or throws, the restored
 * requester source is released here; otherwise its caller keeps it.
 */
export async function prepareSessionParticipantSystemTurnAuthority(params: {
  context: GatewayRequestContext;
  agentId: string;
  entry: SessionEntry;
  restored?: { authority: AdmittedRunOperatorAuthority; release: () => void };
  assertCurrent?: () => void;
}): Promise<{ authority: AdmittedRunOperatorAuthority; release: () => void } | undefined> {
  const { restored } = params;
  try {
    const delegated = await prepareSessionDelegatedOperatorAuthority({
      context: params.context,
      agentId: params.agentId,
      entry: params.entry,
      authority: restored?.authority,
      assertCurrent: params.assertCurrent,
    });
    if (delegated) {
      restored?.release();
      return delegated;
    }
    if (!restored?.authority.participationCeiling) {
      return undefined;
    }
    const release = restored.authority.retain?.();
    if (!release) {
      throw new Error("Participant restart requires retained authority.");
    }
    restored.release();
    return { authority: restored.authority, release };
  } catch (error) {
    restored?.release();
    throw error;
  }
}
