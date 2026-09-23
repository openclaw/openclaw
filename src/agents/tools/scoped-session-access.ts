import { isPerAgentSessionStoreConfig } from "../../config/sessions/session-store-config.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareSessionMutationFacts } from "../../gateway/session-sharing-preparation.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { resolveSessionAgentIds } from "../agent-scope.js";

/** Resolves a target key without letting requester scope override a durable fixed-store owner. */
export function resolveSessionToolTargetAgentId(params: {
  cfg: OpenClawConfig;
  targetSessionKey: string;
  resolvedAgentId?: string;
  requesterAgentId?: string;
}): string {
  const persistedOwner = resolvePersistedSessionStoreOwnerForKey(
    params.cfg,
    params.targetSessionKey,
  );
  const canUseRequesterScope =
    !params.resolvedAgentId &&
    !parseAgentSessionKey(params.targetSessionKey)?.agentId &&
    persistedOwner.kind === "none" &&
    isPerAgentSessionStoreConfig(params.cfg.session?.store);
  return resolveSessionAgentIds({
    config: params.cfg,
    sessionKey: params.targetSessionKey,
    agentId: params.resolvedAgentId ?? (canUseRequesterScope ? params.requesterAgentId : undefined),
  }).sessionAgentId;
}

/** Linearizes a host-scoped grant against reset/delete of its expected incarnation. */
export async function runWithScopedSessionAccess<T>(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  expectedSessionId?: string;
  signal?: AbortSignal;
  targetSessionKey: string;
  run: () => Promise<T>;
}): Promise<T> {
  const expectedSessionId = params.expectedSessionId?.trim();
  if (!expectedSessionId) {
    return await params.run();
  }
  const { sessionAgentId: agentId } = resolveSessionAgentIds({
    config: params.cfg,
    sessionKey: params.targetSessionKey,
    agentId: params.agentId,
  });
  const prepared = await prepareSessionMutationFacts({
    cfg: params.cfg,
    agentId,
    sessionKey: params.targetSessionKey,
    allowMissing: true,
  });
  try {
    const assertExpectedIncarnation = () => {
      const target = prepared.readCurrent(params.cfg).target;
      if (target?.entry.sessionId !== expectedSessionId || target.entry.archivedAt !== undefined) {
        throw new Error(`Session "${params.targetSessionKey}" changed after access was granted.`);
      }
    };
    assertExpectedIncarnation();
    const admission = await beginSessionWorkAdmission({
      scope: prepared.readCurrent(params.cfg).location.storePath,
      identities: [params.targetSessionKey, expectedSessionId],
      assertAllowed: assertExpectedIncarnation,
      revalidateAllowed: assertExpectedIncarnation,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    try {
      return await admission.run(params.run);
    } finally {
      admission.release();
    }
  } finally {
    prepared.release();
  }
}
