import { buildMainSessionRecoveryClearPatch } from "../../agents/main-session-recovery/main-session-recovery-clear.js";
import type { InternalSessionEntry, SessionEntry } from "../../config/sessions.js";
import {
  isRestartRecoveryTombstone,
  SessionRestartRecoveryTombstoneError,
} from "../../config/sessions/lifecycle.js";
import { sessionEntryForkedFromParent } from "../../config/sessions/session-entry-lineage.js";
import { isModelSelectionLocked } from "../../sessions/model-overrides.js";
import { forkSessionFromParent, resolveParentForkDecision } from "./session-fork.js";

export function canReplaceRestartTombstoneFromParent(params: {
  actorType: "agent" | "human" | "system";
  entry?: SessionEntry;
  hasParentForkSource: boolean;
  hasPluginOwnedBinding?: boolean;
  inboundAccessAuthorized?: boolean;
  inboundEventKind?: string;
  nativeCommandTarget?: string;
  sessionKey?: string;
}): boolean {
  return (
    params.hasParentForkSource &&
    isRestartRecoveryTombstone(params.entry) &&
    !isModelSelectionLocked(params.entry) &&
    !sessionEntryForkedFromParent(params.entry) &&
    params.hasPluginOwnedBinding !== true &&
    params.entry?.pluginOwnerId === undefined &&
    params.inboundAccessAuthorized === true &&
    params.inboundEventKind !== "room_event" &&
    params.actorType === "human" &&
    (params.nativeCommandTarget === undefined || params.nativeCommandTarget === params.sessionKey)
  );
}

export async function prepareReplySessionParentFork(params: {
  agentId: string;
  alreadyForked: boolean;
  parentSessionKey?: string;
  requireParentForkReplacement?: boolean;
  readEntry: (sessionKey: string) => SessionEntry | undefined;
  sessionEntry: SessionEntry;
  sessionKey: string;
  storePath: string;
  warn: (message: string) => void;
}): Promise<SessionEntry> {
  if (
    !params.parentSessionKey ||
    params.parentSessionKey === params.sessionKey ||
    params.alreadyForked
  ) {
    return params.sessionEntry;
  }
  const unresolvedParentFork = () => {
    if (params.requireParentForkReplacement === true) {
      throw new SessionRestartRecoveryTombstoneError(
        `Session "${params.sessionKey}" ended during restart recovery. Use /new or /reset to start a replacement session.`,
      );
    }
    return params.sessionEntry;
  };
  const parentEntry = params.readEntry(params.parentSessionKey);
  if (!parentEntry?.sessionId) {
    return unresolvedParentFork();
  }
  const forkParams = {
    parentSessionKey: params.parentSessionKey,
    parentEntry,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  };
  const decision = await resolveParentForkDecision(forkParams);
  if (decision.status === "skip") {
    // The parent branch is too large to inherit usefully. Start fresh and
    // mark as handled so the thread does not retry this decision every turn.
    params.warn(
      `skipping parent fork (parent too large): parentKey=${params.parentSessionKey} → sessionKey=${params.sessionKey} ` +
        `parentTokens=${decision.parentTokens} maxTokens=${decision.maxTokens}`,
    );
    return { ...params.sessionEntry, forkedFromParent: true };
  }
  const fork = await forkSessionFromParent(forkParams);
  if (!fork) {
    return unresolvedParentFork();
  }
  params.warn(
    `forking from parent session: parentKey=${params.parentSessionKey} → sessionKey=${params.sessionKey} ` +
      `parentTokens=${decision.parentTokens ?? "unknown"}`,
  );
  // A fork replaces the incarnation; its prior recovery state and native grant must not carry over.
  const forkedEntry: InternalSessionEntry = {
    ...params.sessionEntry,
    ...buildMainSessionRecoveryClearPatch(params.sessionEntry),
    sessionId: fork.sessionId,
    nativeRuntimeConsent: undefined,
    lifecycleRunId: undefined,
    lastRunId: undefined,
    forkSource: {
      sessionKey: params.parentSessionKey,
      sessionId: parentEntry.sessionId,
    },
    forkedFromParent: true,
    totalTokens: undefined,
    totalTokensFresh: false,
    totalTokensVersion: undefined,
  };
  return forkedEntry;
}
