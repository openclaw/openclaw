import type { InternalSessionEntry, SessionEntry } from "../../config/sessions.js";
import { forkSessionFromParent, resolveParentForkDecision } from "./session-fork.js";

export async function prepareReplySessionParentFork(params: {
  agentId: string;
  alreadyForked: boolean;
  parentSessionKey?: string;
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
  const parentEntry = params.readEntry(params.parentSessionKey);
  if (!parentEntry?.sessionId) {
    return params.sessionEntry;
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
    return params.sessionEntry;
  }
  params.warn(
    `forking from parent session: parentKey=${params.parentSessionKey} → sessionKey=${params.sessionKey} ` +
      `parentTokens=${decision.parentTokens ?? "unknown"}`,
  );
  // A fork replaces the incarnation; its pending resume marker and native grant do not carry over.
  const forkedEntry: InternalSessionEntry = {
    ...params.sessionEntry,
    resumeAfterRestart: undefined,
    abortedLastRun: false,
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
