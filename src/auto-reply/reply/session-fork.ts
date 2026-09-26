import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  forkSessionEntryFromParentTarget,
  forkSessionFromParentTranscript,
  resolveSessionParentForkDecision,
  type ForkSessionEntryFromParentTargetParams,
  type ForkSessionEntryFromParentTargetResult,
  type SessionParentForkDecision,
} from "../../config/sessions/session-accessor.js";
import { prepareSessionForkTranscript } from "../../config/sessions/session-accessor.sqlite-parent-session.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  assertModelSelectionUnlocked,
  MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE,
} from "../../sessions/model-overrides.js";

export { MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE } from "../../sessions/model-overrides.js";

type ParentForkDecisionParams = {
  parentEntry: SessionEntry;
  agentId?: string;
  config?: OpenClawConfig;
  storePath?: string;
};

type ForkSessionFromParentParams = {
  maxTokens?: number;
  parentSessionKey: string;
  parentEntry: SessionEntry;
  agentId: string;
  commitGuard?: () => void;
  config?: OpenClawConfig;
  sessionKey: string;
  storePath?: string;
  forkFrom?: "last-completed";

  /** Cross-agent forks land the child transcript in the target agent's store. */
  targetStorePath?: string;
};

type ForkSessionEntryFromParentParams = Omit<ForkSessionFromParentParams, "parentEntry"> &
  Pick<
    ForkSessionEntryFromParentTargetParams,
    "fallbackEntry" | "patch" | "skipForkWhen" | "skipPatch" | "decisionSkipPatch"
  > & {
    parentStoreKeys?: readonly string[];
    sessionStoreKeys?: readonly string[];
  };

function resolveParentForkStorePath(params: {
  agentId?: string;
  config?: OpenClawConfig;
  storePath?: string;
}): string {
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
    storePath: resolveParentForkStorePath(params),
  });
}

export async function forkSessionFromParent(
  params: ForkSessionFromParentParams,
): Promise<{ sessionId: string; sessionFile: string } | null> {
  // Keep direct callers fail-closed even if they skipped the normal decision step.
  assertModelSelectionUnlocked(params.parentEntry, MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE);
  const storePath = resolveParentForkStorePath(params);
  const fork = await forkSessionFromParentTranscript({
    agentId: params.agentId,
    ...(params.commitGuard ? { commitGuard: params.commitGuard } : {}),
    parentEntry: params.parentEntry,
    parentSessionKey: params.parentSessionKey,
    sessionKey: params.sessionKey,
    storePath,
    ...(params.forkFrom ? { forkFrom: params.forkFrom } : {}),
    ...(params.targetStorePath ? { targetStorePath: params.targetStorePath } : {}),
  });
  return fork.status === "created" ? fork.transcript : null;
}

export async function prepareSessionForkFromParent(params: ForkSessionFromParentParams) {
  assertModelSelectionUnlocked(params.parentEntry, MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE);
  return await prepareSessionForkTranscript({
    agentId: params.agentId,
    ...(params.commitGuard ? { commitGuard: params.commitGuard } : {}),
    enforceTokenLimit: true,
    ...(params.maxTokens ? { maxTokens: params.maxTokens } : {}),
    parentEntry: params.parentEntry,
    parentSessionKey: params.parentSessionKey,
    sessionKey: params.sessionKey,
    storePath: resolveParentForkStorePath(params),
    ...(params.forkFrom ? { forkFrom: params.forkFrom } : {}),
    ...(params.targetStorePath ? { targetStorePath: params.targetStorePath } : {}),
  });
}

function normalizeForkTarget(params: { canonicalKey: string; storeKeys?: readonly string[] }): {
  canonicalKey: string;
  storeKeys: string[];
} {
  const keys = new Set<string>();
  const remember = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) {
      keys.add(trimmed);
    }
  };
  remember(params.canonicalKey);
  for (const key of params.storeKeys ?? []) {
    remember(key);
  }
  return { canonicalKey: params.canonicalKey, storeKeys: [...keys] };
}

/**
 * Forks the parent transcript and persists the child session entry through one
 * storage boundary operation.
 */
export async function forkSessionEntryFromParent(
  params: ForkSessionEntryFromParentParams,
): Promise<ForkSessionEntryFromParentTargetResult> {
  const storePath = resolveParentForkStorePath(params);
  return await forkSessionEntryFromParentTarget({
    agentId: params.agentId,
    commitGuard: params.commitGuard,
    decisionSkipPatch: params.decisionSkipPatch,
    fallbackEntry: params.fallbackEntry,
    parentTarget: normalizeForkTarget({
      canonicalKey: params.parentSessionKey,
      storeKeys: params.parentStoreKeys,
    }),
    patch: params.patch,
    sessionTarget: normalizeForkTarget({
      canonicalKey: params.sessionKey,
      storeKeys: params.sessionStoreKeys,
    }),
    skipForkWhen: params.skipForkWhen,
    skipPatch: params.skipPatch,
    storePath,
  });
}
