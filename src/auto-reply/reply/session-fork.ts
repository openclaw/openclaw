import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  forkSessionFromParentTranscript,
  resolveSessionParentForkDecision,
  type ForkSessionEntryFromParentTargetParams,
  type ForkSessionEntryFromParentTargetResult,
  type SessionParentForkDecision,
} from "../../config/sessions/session-accessor.js";
import {
  forkSessionEntryFromParentTargetWithPatch,
  prepareSessionForkTranscript,
} from "../../config/sessions/session-accessor.sqlite-parent-session.js";
import type { ParentForkEntryPatch } from "../../config/sessions/session-parent-fork.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  assertModelSelectionUnlocked,
  MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE,
} from "../../sessions/model-overrides.js";

export { MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE } from "../../sessions/model-overrides.js";

type ParentForkDecisionParams = {
  parentSessionKey?: string;
  parentEntry: SessionEntry;
  agentId?: string;
  config?: OpenClawConfig;
  storePath?: string;
};

type ForkSessionFromParentParams = ParentForkDecisionParams & {
  maxTokens?: number;
  parentSessionKey: string;
  agentId: string;
  commitGuard?: () => void;
  sessionKey: string;
  forkFrom?: "last-completed";

  /** Cross-agent forks land the child transcript in the target agent's store. */
  targetStorePath?: string;
};

type ForkSessionEntryFromParentParams = Omit<ForkSessionFromParentParams, "parentEntry"> &
  Pick<ForkSessionEntryFromParentTargetParams, "fallbackEntry"> & {
    entryPatch?: ParentForkEntryPatch;
    parentStoreKeys?: readonly string[];
    sessionStoreKeys?: readonly string[];
  };

function resolveParentForkStorePath(
  params: Pick<ParentForkDecisionParams, "agentId" | "config" | "storePath">,
): string {
  return (
    params.storePath ??
    resolveSessionStorePathCore(params.config?.session?.store, { agentId: params.agentId })
  );
}

export async function resolveParentForkDecision(
  params: ParentForkDecisionParams,
): Promise<SessionParentForkDecision> {
  assertModelSelectionUnlocked(params.parentEntry, MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE);
  return await resolveSessionParentForkDecision({
    parentEntry: params.parentEntry,
    parentSessionKey: params.parentSessionKey,
    storePath: resolveParentForkStorePath(params),
  });
}

function resolveParentForkParams(params: ForkSessionFromParentParams) {
  // Keep direct callers fail-closed even if they skipped the normal decision step.
  assertModelSelectionUnlocked(params.parentEntry, MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE);
  return {
    agentId: params.agentId,
    ...(params.commitGuard ? { commitGuard: params.commitGuard } : {}),
    parentEntry: params.parentEntry,
    parentSessionKey: params.parentSessionKey,
    sessionKey: params.sessionKey,
    storePath: resolveParentForkStorePath(params),
    ...(params.forkFrom ? { forkFrom: params.forkFrom } : {}),
    ...(params.targetStorePath ? { targetStorePath: params.targetStorePath } : {}),
  };
}

export async function forkSessionFromParent(
  params: ForkSessionFromParentParams,
): Promise<{ sessionId: string; sessionFile: string } | null> {
  const fork = await forkSessionFromParentTranscript(resolveParentForkParams(params));
  return fork.status === "created" ? fork.transcript : null;
}

export async function prepareSessionForkFromParent(params: ForkSessionFromParentParams) {
  return await prepareSessionForkTranscript({
    ...resolveParentForkParams(params),
    enforceTokenLimit: true,
    ...(params.maxTokens ? { maxTokens: params.maxTokens } : {}),
  });
}

function normalizeForkTarget(
  canonicalKey: string,
  storeKeys?: readonly string[],
): {
  canonicalKey: string;
  storeKeys: string[];
} {
  return {
    canonicalKey,
    storeKeys: [
      ...new Set([canonicalKey, ...(storeKeys ?? [])].map((key) => key.trim()).filter(Boolean)),
    ],
  };
}

/**
 * Forks the parent transcript and persists the child session entry through one
 * storage boundary operation.
 */
export async function forkSessionEntryFromParent(
  params: ForkSessionEntryFromParentParams,
): Promise<ForkSessionEntryFromParentTargetResult> {
  const storePath = resolveParentForkStorePath(params);
  return await forkSessionEntryFromParentTargetWithPatch(
    {
      agentId: params.agentId,
      commitGuard: params.commitGuard,
      fallbackEntry: params.fallbackEntry,
      parentTarget: normalizeForkTarget(params.parentSessionKey, params.parentStoreKeys),
      sessionTarget: normalizeForkTarget(params.sessionKey, params.sessionStoreKeys),
      storePath,
    },
    params.entryPatch,
  );
}
