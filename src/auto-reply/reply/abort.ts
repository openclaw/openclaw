// Handles abort requests and active reply run cancellation.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  type AcpSessionCancelTarget,
  getAcpSessionManager,
  type AcpSessionResolution,
} from "../../acp/control-plane/manager.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  abortEmbeddedAgentRun,
  captureActiveEmbeddedRunIdentity,
  resolveActiveEmbeddedRunSessionId,
  type CapturedActiveEmbeddedRunIdentity,
} from "../../agents/embedded-agent-runner/runs.js";
import {
  getLatestSubagentRunByChildSessionKey,
  listSubagentRunsForController,
  markSubagentRunTerminated,
} from "../../agents/subagent-registry.js";
import type { SubagentRunRecord } from "../../agents/subagent-registry.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../agents/tools/sessions-helpers.js";
import { resolveStorePath } from "../../config/sessions.js";
import {
  loadSessionEntry,
  markSessionAbortTarget,
  resolveSessionAbortTarget,
  type SessionAbortTargetContext,
  type SessionAbortTargetIdentity,
  type SessionAbortTargetResult,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  createAuthorizationInvocationContext,
  createAuthorizationPrincipal,
  normalizeAuthorizationCommandSource,
} from "../../plugins/authorization-policy-context.js";
import { runAuthorizationPolicies } from "../../plugins/authorization-policy.js";
import {
  classifyTurnAuthoritySnapshot,
  type ClassifiedTurnAuthority,
} from "../../plugins/turn-authority.js";
import { isAcpSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { FinalizedMsgContext } from "../templating.js";
import {
  type AbortCutoff,
  resolveAbortCutoffFromContext,
  shouldPersistAbortCutoff,
} from "./abort-cutoff.js";
import { isAbortRequestText, isAbortTrigger, setAbortMemory } from "./abort-primitives.js";
import { resolveEffectiveResetTargetSessionKey } from "./acp-reset-target.js";
import { resolveCommandAuthorizationThreadId } from "./commands-authorization.js";
import { resolveConversationBindingContextFromMessage } from "./conversation-binding-input.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";
import { clearSessionQueues } from "./queue.js";
import { replyRunRegistry, type ReplyOperation } from "./reply-run-registry.js";

export { isAbortRequestText, isAbortTrigger, setAbortMemory };

const defaultAbortDeps = {
  getAcpSessionManager,
  abortEmbeddedAgentRun,
  captureActiveEmbeddedRunIdentity,
  resolveActiveEmbeddedRunSessionId,
  markSessionAbortTarget,
  resolveSessionAbortTarget,
  getLatestSubagentRunByChildSessionKey,
  listSubagentRunsForController,
  markSubagentRunTerminated,
};

const abortDeps = {
  ...defaultAbortDeps,
};

const abortTestApi = {
  setDepsForTests(deps: Partial<typeof defaultAbortDeps> | undefined): void {
    abortDeps.getAcpSessionManager =
      deps?.getAcpSessionManager ?? defaultAbortDeps.getAcpSessionManager;
    abortDeps.abortEmbeddedAgentRun =
      deps?.abortEmbeddedAgentRun ?? defaultAbortDeps.abortEmbeddedAgentRun;
    abortDeps.captureActiveEmbeddedRunIdentity =
      deps?.captureActiveEmbeddedRunIdentity ?? defaultAbortDeps.captureActiveEmbeddedRunIdentity;
    abortDeps.resolveActiveEmbeddedRunSessionId =
      deps?.resolveActiveEmbeddedRunSessionId ?? defaultAbortDeps.resolveActiveEmbeddedRunSessionId;
    abortDeps.markSessionAbortTarget =
      deps?.markSessionAbortTarget ?? defaultAbortDeps.markSessionAbortTarget;
    abortDeps.resolveSessionAbortTarget =
      deps?.resolveSessionAbortTarget ?? defaultAbortDeps.resolveSessionAbortTarget;
    abortDeps.getLatestSubagentRunByChildSessionKey =
      deps?.getLatestSubagentRunByChildSessionKey ??
      defaultAbortDeps.getLatestSubagentRunByChildSessionKey;
    abortDeps.listSubagentRunsForController =
      deps?.listSubagentRunsForController ?? defaultAbortDeps.listSubagentRunsForController;
    abortDeps.markSubagentRunTerminated =
      deps?.markSubagentRunTerminated ?? defaultAbortDeps.markSubagentRunTerminated;
  },
  resetDepsForTests(): void {
    abortDeps.getAcpSessionManager = defaultAbortDeps.getAcpSessionManager;
    abortDeps.abortEmbeddedAgentRun = defaultAbortDeps.abortEmbeddedAgentRun;
    abortDeps.captureActiveEmbeddedRunIdentity = defaultAbortDeps.captureActiveEmbeddedRunIdentity;
    abortDeps.resolveActiveEmbeddedRunSessionId =
      defaultAbortDeps.resolveActiveEmbeddedRunSessionId;
    abortDeps.markSessionAbortTarget = defaultAbortDeps.markSessionAbortTarget;
    abortDeps.resolveSessionAbortTarget = defaultAbortDeps.resolveSessionAbortTarget;
    abortDeps.getLatestSubagentRunByChildSessionKey =
      defaultAbortDeps.getLatestSubagentRunByChildSessionKey;
    abortDeps.listSubagentRunsForController = defaultAbortDeps.listSubagentRunsForController;
    abortDeps.markSubagentRunTerminated = defaultAbortDeps.markSubagentRunTerminated;
  },
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.abortTestApi")] = abortTestApi;
}

export function abortSessionRunTargetWithOutcome(params: { key?: string; sessionId?: string }): {
  active: boolean;
  aborted: boolean;
} {
  const sessionIds = new Set<string>();
  const key = normalizeOptionalString(params.key);
  let active = key ? replyRunRegistry.isActive(key) : false;
  if (key) {
    const activeSessionId = abortDeps.resolveActiveEmbeddedRunSessionId(key);
    if (activeSessionId) {
      active = true;
      sessionIds.add(activeSessionId);
    }
  }
  const explicitSessionId = normalizeOptionalString(params.sessionId);
  if (explicitSessionId) {
    sessionIds.add(explicitSessionId);
  }

  let aborted = key ? replyRunRegistry.abort(key) : false;
  for (const sessionId of sessionIds) {
    aborted = abortDeps.abortEmbeddedAgentRun(sessionId) || aborted;
  }
  return { active, aborted };
}

export function formatAbortReplyText(
  stoppedSubagents?: number,
  rejectionReason?: "finalizing" | "policy-denied",
): string {
  if (rejectionReason === "policy-denied") {
    return "Command blocked by authorization policy.";
  }
  if (rejectionReason === "finalizing") {
    const base = "Agent reply is already finalizing and can no longer be aborted.";
    if (typeof stoppedSubagents !== "number" || stoppedSubagents <= 0) {
      return base;
    }
    const label = stoppedSubagents === 1 ? "sub-agent" : "sub-agents";
    return `${base} Stopped ${stoppedSubagents} ${label}.`;
  }
  if (typeof stoppedSubagents !== "number" || stoppedSubagents <= 0) {
    return "⚙️ Agent was aborted.";
  }
  const label = stoppedSubagents === 1 ? "sub-agent" : "sub-agents";
  return `⚙️ Agent was aborted. Stopped ${stoppedSubagents} ${label}.`;
}

function resolveStoredSessionId(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): string | undefined {
  const agentId = resolveSessionAgentId({
    sessionKey: params.sessionKey,
    config: params.cfg,
  });
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
  try {
    return abortDeps.resolveSessionAbortTarget({
      agentId,
      sessionKey: params.sessionKey,
      storePath,
    })?.sessionId;
  } catch {
    return undefined;
  }
}

type FastAbortSessionSnapshot = Readonly<{
  key: string;
  storedSessionId?: string;
  activeSessionId?: string;
  replySessionId?: string;
  replyOperation?: ReplyOperation;
  embeddedIdentity?: CapturedActiveEmbeddedRunIdentity;
}>;

type FastAbortAcpSnapshot = Readonly<{
  key: string;
  identity: string;
  expectedTarget?: AcpSessionCancelTarget;
}>;

function captureFastAbortSessionSnapshot(params: {
  cfg: OpenClawConfig;
  key: string;
  storedSessionId?: string;
}): FastAbortSessionSnapshot {
  const activeSessionId = abortDeps.resolveActiveEmbeddedRunSessionId(params.key);
  const replyOperation = replyRunRegistry.get(params.key);
  const replySessionId = replyOperation?.sessionId;
  const storedSessionId =
    params.storedSessionId ?? resolveStoredSessionId({ cfg: params.cfg, sessionKey: params.key });
  // ReplyOperation already owns exact cancellation for its backend. Only use a
  // direct embedded handle when no operation owns the captured run.
  const embeddedIdentityCandidate =
    activeSessionId ?? (replyOperation ? undefined : storedSessionId);
  const embeddedIdentity = embeddedIdentityCandidate
    ? abortDeps.captureActiveEmbeddedRunIdentity(embeddedIdentityCandidate)
    : undefined;
  return Object.freeze({
    key: params.key,
    ...(storedSessionId ? { storedSessionId } : {}),
    ...(activeSessionId ? { activeSessionId } : {}),
    ...(replySessionId ? { replySessionId } : {}),
    ...(replyOperation ? { replyOperation } : {}),
    ...(embeddedIdentity ? { embeddedIdentity } : {}),
  });
}

function fastAbortSessionSnapshotMatchesCurrent(
  snapshot: FastAbortSessionSnapshot,
  cfg: OpenClawConfig,
  options: { allowEnded: boolean },
): boolean {
  const storedSessionId = resolveStoredSessionId({ cfg, sessionKey: snapshot.key });
  if (storedSessionId !== snapshot.storedSessionId) {
    return false;
  }
  const activeSessionId = abortDeps.resolveActiveEmbeddedRunSessionId(snapshot.key);
  const replyOperation = replyRunRegistry.get(snapshot.key);
  const replySessionId = replyOperation?.sessionId;
  if (options.allowEnded) {
    if (
      (activeSessionId !== undefined && activeSessionId !== snapshot.activeSessionId) ||
      (replySessionId !== undefined && replySessionId !== snapshot.replySessionId) ||
      (replyOperation !== undefined && replyOperation !== snapshot.replyOperation)
    ) {
      return false;
    }
    if (
      activeSessionId !== undefined &&
      snapshot.embeddedIdentity &&
      !snapshot.embeddedIdentity.isCurrent()
    ) {
      return false;
    }
    return true;
  }
  return (
    activeSessionId === snapshot.activeSessionId &&
    replySessionId === snapshot.replySessionId &&
    replyOperation === snapshot.replyOperation &&
    (!snapshot.embeddedIdentity || snapshot.embeddedIdentity.isCurrent())
  );
}

function abortFastSessionSnapshot(snapshot: FastAbortSessionSnapshot): {
  active: boolean;
  aborted: boolean;
  replacementObserved: boolean;
} {
  if (snapshot.embeddedIdentity) {
    const outcome = snapshot.embeddedIdentity.abortIfCurrent();
    return {
      active: outcome.status !== "not_active",
      aborted: outcome.status === "aborted",
      replacementObserved: outcome.replacementObserved,
    };
  }
  if (snapshot.replyOperation) {
    if (replyRunRegistry.get(snapshot.key) !== snapshot.replyOperation) {
      return { active: false, aborted: false, replacementObserved: true };
    }
    const aborted = snapshot.replyOperation.abortByUser();
    const current = replyRunRegistry.get(snapshot.key);
    return {
      active: true,
      aborted,
      replacementObserved: current !== undefined && current !== snapshot.replyOperation,
    };
  }
  if (snapshot.activeSessionId || snapshot.replySessionId) {
    // The run changed while its opaque identity was being captured. Never fall
    // back to a key lookup that could cancel the replacement.
    return { active: true, aborted: false, replacementObserved: true };
  }
  return { active: false, aborted: false, replacementObserved: false };
}

function serializeAcpAbortIdentity(resolution: AcpSessionResolution): string {
  if (resolution.kind !== "ready") {
    return `${resolution.kind}\u0000${resolution.sessionKey}`;
  }
  const identity = resolution.meta.identity;
  return [
    resolution.kind,
    resolution.sessionKey,
    resolution.entry?.sessionId ?? "",
    resolution.meta.backend,
    resolution.meta.agent,
    resolution.meta.runtimeSessionName,
    identity?.state ?? "",
    identity?.acpxRecordId ?? "",
    identity?.acpxSessionId ?? "",
    identity?.agentSessionId ?? "",
  ].join("\u0000");
}

function captureAcpCancelTarget(params: {
  resolution: AcpSessionResolution;
  sessionId?: string;
}): AcpSessionCancelTarget | undefined {
  if (params.resolution.kind !== "ready" || !params.sessionId) {
    return undefined;
  }
  const identity = params.resolution.meta.identity;
  return Object.freeze({
    sessionId: params.sessionId,
    backend: params.resolution.meta.backend,
    agent: params.resolution.meta.agent,
    runtimeSessionName: params.resolution.meta.runtimeSessionName,
    ...(identity
      ? {
          identity: Object.freeze({
            state: identity.state,
            ...(identity.acpxRecordId !== undefined ? { acpxRecordId: identity.acpxRecordId } : {}),
            ...(identity.acpxSessionId !== undefined
              ? { acpxSessionId: identity.acpxSessionId }
              : {}),
            ...(identity.agentSessionId !== undefined
              ? { agentSessionId: identity.agentSessionId }
              : {}),
          }),
        }
      : {}),
  });
}

function captureFastAbortAcpSnapshot(params: {
  acpManager: ReturnType<typeof getAcpSessionManager>;
  cfg: OpenClawConfig;
  session: FastAbortSessionSnapshot;
}): FastAbortAcpSnapshot | undefined {
  if (!isAcpSessionKey(params.session.key)) {
    return undefined;
  }
  const resolution = params.acpManager.resolveSession({
    cfg: params.cfg,
    sessionKey: params.session.key,
  });
  if (resolution.kind === "none") {
    return undefined;
  }
  const expectedTarget = captureAcpCancelTarget({
    resolution,
    sessionId: params.session.storedSessionId,
  });
  return Object.freeze({
    key: params.session.key,
    identity: serializeAcpAbortIdentity(resolution),
    ...(expectedTarget ? { expectedTarget } : {}),
  });
}

function fastAbortAcpSnapshotMatchesCurrent(params: {
  acpManager: ReturnType<typeof getAcpSessionManager>;
  cfg: OpenClawConfig;
  snapshot: FastAbortAcpSnapshot;
}): boolean {
  return (
    serializeAcpAbortIdentity(
      params.acpManager.resolveSession({
        cfg: params.cfg,
        sessionKey: params.snapshot.key,
      }),
    ) === params.snapshot.identity
  );
}

function resolveBoundAcpAbortTargetSessionKey(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  activeSessionKey: string;
}): string | undefined {
  const bindingContext = resolveConversationBindingContextFromMessage({
    cfg: params.cfg,
    ctx: params.ctx,
  });
  if (!bindingContext) {
    return undefined;
  }
  return resolveEffectiveResetTargetSessionKey({
    cfg: params.cfg,
    channel: bindingContext.channel,
    accountId: bindingContext.accountId,
    conversationId: bindingContext.conversationId,
    parentConversationId: bindingContext.parentConversationId,
    activeSessionKey: params.activeSessionKey,
    skipConfiguredFallbackWhenActiveSessionNonAcp: false,
    fallbackToActiveAcpWhenUnbound: false,
  });
}

function normalizeRequesterSessionKey(
  cfg: OpenClawConfig,
  key: string | undefined,
): string | undefined {
  const cleaned = normalizeOptionalString(key);
  if (!cleaned) {
    return undefined;
  }
  const { mainKey, alias } = resolveMainSessionAlias(cfg);
  return resolveInternalSessionKey({ key: cleaned, alias, mainKey });
}

function resolveFastAbortAuthorizationContext(params: {
  turnAuthority: ClassifiedTurnAuthority;
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  legacy: {
    provider?: string;
    accountId?: string;
    senderId?: string;
    senderName?: string;
    senderUsername?: string;
    senderE164?: string;
    senderIsOwner: boolean;
    isAuthorizedSender: boolean;
    roleIds?: readonly string[];
    conversationId?: string;
    parentConversationId?: string;
    threadId?: string | number;
  };
}) {
  if (params.turnAuthority.kind === "invalid") {
    return undefined;
  }
  const admitted =
    params.turnAuthority.kind === "issued"
      ? params.turnAuthority.snapshot.authorization
      : undefined;
  if (admitted) {
    // Principal and conversation come only from the admitted turn. Rebind the
    // execution scope and trigger to the command that /stop will actually run.
    return createAuthorizationInvocationContext({
      principal: admitted.principal,
      agentId: params.sessionKey ? params.agentId : admitted.agentId,
      sessionKey: params.sessionKey ?? admitted.sessionKey,
      sessionId: params.sessionKey ? params.sessionId : admitted.sessionId,
      runId: admitted.runId,
      conversationId: admitted.conversationId,
      parentConversationId: admitted.parentConversationId,
      threadId: admitted.threadId,
      trigger: "command",
    });
  }
  return createAuthorizationInvocationContext({
    principal: createAuthorizationPrincipal({
      provider: params.legacy.provider,
      accountId: params.legacy.accountId,
      senderId: params.legacy.senderId,
      senderName: params.legacy.senderName,
      senderUsername: params.legacy.senderUsername,
      senderE164: params.legacy.senderE164,
      senderIsOwner: params.legacy.senderIsOwner,
      isAuthorizedSender: params.legacy.isAuthorizedSender,
      roleIds: params.legacy.roleIds,
    }),
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    conversationId: params.legacy.conversationId,
    parentConversationId: params.legacy.parentConversationId,
    threadId: params.legacy.threadId,
    trigger: "command",
  });
}

function markSubagentRunTerminatedBestEffort(
  params: Parameters<typeof markSubagentRunTerminated>[0],
): number {
  try {
    return abortDeps.markSubagentRunTerminated(params);
  } catch (error) {
    // The runtime abort already happened. Keep stopping siblings and descendants;
    // durable reconciliation can retry the rolled-back registry transition later.
    logVerbose(
      `abort: failed to persist killed subagent ${params.runId ?? params.childSessionKey ?? "unknown"}: ${formatErrorMessage(error)}`,
    );
    return 0;
  }
}

export function stopSubagentsForRequester(params: {
  cfg: OpenClawConfig;
  requesterSessionKey?: string;
}): { stopped: number } {
  const requesterKey = normalizeRequesterSessionKey(params.cfg, params.requesterSessionKey);
  if (!requesterKey) {
    return { stopped: 0 };
  }
  const dedupedRunsByChildKey = new Map<string, SubagentRunRecord>();
  for (const run of abortDeps.listSubagentRunsForController(requesterKey)) {
    const childKey = normalizeOptionalString(run.childSessionKey);
    if (!childKey) {
      continue;
    }
    const latest = abortDeps.getLatestSubagentRunByChildSessionKey(childKey);
    if (!latest) {
      const existing = dedupedRunsByChildKey.get(childKey);
      if (!existing || run.createdAt >= existing.createdAt) {
        dedupedRunsByChildKey.set(childKey, run);
      }
      continue;
    }
    const latestControllerSessionKey =
      normalizeOptionalString(latest?.controllerSessionKey) ??
      normalizeOptionalString(latest?.requesterSessionKey);
    if (latest.runId !== run.runId || latestControllerSessionKey !== requesterKey) {
      continue;
    }
    const existing = dedupedRunsByChildKey.get(childKey);
    if (!existing || run.createdAt >= existing.createdAt) {
      dedupedRunsByChildKey.set(childKey, run);
    }
  }
  const runs = Array.from(dedupedRunsByChildKey.values());
  if (runs.length === 0) {
    return { stopped: 0 };
  }

  const seenChildKeys = new Set<string>();
  let stopped = 0;

  for (const run of runs) {
    const childKey = normalizeOptionalString(run.childSessionKey);
    if (!childKey || seenChildKeys.has(childKey)) {
      continue;
    }
    seenChildKeys.add(childKey);

    if (!run.endedAt || run.pauseReason === "sessions_yield") {
      const cleared = clearSessionQueues([childKey]);
      const parsed = parseAgentSessionKey(childKey);
      const storePath = resolveStorePath(params.cfg.session?.store, { agentId: parsed?.agentId });
      const sessionId =
        replyRunRegistry.resolveSessionId(childKey) ??
        loadSessionEntry({
          agentId: parsed?.agentId,
          clone: false,
          sessionKey: childKey,
          storePath,
        })?.sessionId;
      const abortOutcome = abortSessionRunTargetWithOutcome({ key: childKey, sessionId });
      const abortRejected = abortOutcome.active && !abortOutcome.aborted;
      const markedTerminated = abortRejected
        ? false
        : markSubagentRunTerminatedBestEffort({
            runId: run.runId,
            childSessionKey: childKey,
            reason: "killed",
            suppressTaskDelivery: true,
          }) > 0;

      if (
        !abortRejected &&
        (markedTerminated ||
          abortOutcome.aborted ||
          cleared.followupCleared > 0 ||
          cleared.laneCleared > 0)
      ) {
        stopped += 1;
      }
    }

    // Cascade: also stop any sub-sub-agents spawned by this child.
    const cascadeResult = stopSubagentsForRequester({
      cfg: params.cfg,
      requesterSessionKey: childKey,
    });
    stopped += cascadeResult.stopped;
  }

  if (stopped > 0) {
    logVerbose(`abort: stopped ${stopped} subagent run(s) for ${requesterKey}`);
  }
  return { stopped };
}

export async function tryFastAbortFromMessage(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
}): Promise<{
  handled: boolean;
  aborted: boolean;
  rejectionReason?: "finalizing" | "policy-denied";
  stoppedSubagents?: number;
}> {
  const { ctx, cfg } = params;
  const commandSessionKey =
    normalizeOptionalString(ctx.SessionKey) ?? normalizeOptionalString(ctx.ParentSessionKey);
  const targetKey = normalizeOptionalString(ctx.CommandTargetSessionKey) ?? commandSessionKey;
  // Use RawBody/CommandBody for abort detection (clean message without structural context).
  const raw = stripStructuralPrefixes(ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "");
  const isGroup = normalizeOptionalLowercaseString(ctx.ChatType) === "group";
  const stripped = isGroup
    ? stripMentions(
        raw,
        ctx,
        cfg,
        resolveSessionAgentId({
          sessionKey: targetKey ?? ctx.SessionKey ?? "",
          config: cfg,
        }),
      )
    : raw;
  const abortRequested = isAbortRequestText(stripped);
  if (!abortRequested) {
    return { handled: false, aborted: false };
  }
  const turnAuthority = classifyTurnAuthoritySnapshot(ctx.TurnAuthority);
  if (turnAuthority.kind === "invalid") {
    return { handled: true, aborted: false, rejectionReason: "policy-denied" };
  }

  const commandAuthorized = ctx.CommandAuthorized;
  const auth = resolveCommandAuthorization({
    ctx,
    cfg,
    commandAuthorized,
  });
  if (!auth.isAuthorizedSender) {
    return { handled: false, aborted: false };
  }

  const agentId = resolveSessionAgentId({
    sessionKey: targetKey ?? ctx.SessionKey ?? "",
    config: cfg,
  });
  const storePath = targetKey ? resolveStorePath(cfg.session?.store, { agentId }) : undefined;
  let resolvedAbortTarget: SessionAbortTargetIdentity | null = null;
  if (targetKey && storePath) {
    try {
      resolvedAbortTarget = abortDeps.resolveSessionAbortTarget({
        agentId,
        sessionKey: targetKey,
        storePath,
      });
    } catch (error) {
      logVerbose(
        `abort: failed to resolve abort metadata for ${targetKey}: ${formatErrorMessage(error)}`,
      );
    }
  }
  const resolvedTargetKey = resolvedAbortTarget?.sessionKey ?? targetKey ?? ctx.SessionKey;
  const conversationBoundAcpTargetKey = commandSessionKey
    ? resolveBoundAcpAbortTargetSessionKey({
        ctx,
        cfg,
        activeSessionKey: commandSessionKey,
      })
    : undefined;
  const boundAcpTargetKey =
    resolvedTargetKey && !isAcpSessionKey(resolvedTargetKey)
      ? conversationBoundAcpTargetKey
      : undefined;
  const abortTargetKeys = resolvedTargetKey ? [resolvedTargetKey] : [];
  if (boundAcpTargetKey && boundAcpTargetKey !== resolvedTargetKey) {
    abortTargetKeys.push(boundAcpTargetKey);
  }
  const sourceAbortKey =
    commandSessionKey &&
    !abortTargetKeys.includes(commandSessionKey) &&
    conversationBoundAcpTargetKey &&
    abortTargetKeys.includes(conversationBoundAcpTargetKey)
      ? commandSessionKey
      : undefined;
  const sessionSnapshots = new Map<string, FastAbortSessionSnapshot>();
  for (const key of [...abortTargetKeys, sourceAbortKey]) {
    if (!key || sessionSnapshots.has(key)) {
      continue;
    }
    sessionSnapshots.set(
      key,
      captureFastAbortSessionSnapshot({
        cfg,
        key,
        ...(key === resolvedAbortTarget?.sessionKey && resolvedAbortTarget.sessionId
          ? { storedSessionId: resolvedAbortTarget.sessionId }
          : {}),
      }),
    );
  }
  const primarySessionSnapshot = resolvedTargetKey
    ? sessionSnapshots.get(resolvedTargetKey)
    : undefined;
  const policySessionKey = primarySessionSnapshot?.key ?? resolvedTargetKey;
  const policySessionId =
    primarySessionSnapshot?.activeSessionId ??
    primarySessionSnapshot?.replySessionId ??
    primarySessionSnapshot?.storedSessionId;
  const acpManager = abortDeps.getAcpSessionManager();
  const acpSnapshots = abortTargetKeys
    .map((key) => sessionSnapshots.get(key))
    .filter((snapshot): snapshot is FastAbortSessionSnapshot => snapshot !== undefined)
    .map((session) => captureFastAbortAcpSnapshot({ acpManager, cfg, session }))
    .filter((snapshot): snapshot is FastAbortAcpSnapshot => snapshot !== undefined);
  const policyContext = resolveFastAbortAuthorizationContext({
    turnAuthority,
    agentId,
    sessionKey: policySessionKey,
    sessionId: policySessionId,
    legacy: {
      provider: ctx.OriginatingChannel ?? ctx.Provider ?? ctx.Surface,
      accountId: ctx.AccountId,
      senderId: auth.senderId,
      senderName: ctx.SenderName,
      senderUsername: ctx.SenderUsername,
      senderE164: ctx.SenderE164,
      senderIsOwner: auth.senderIsOwner,
      isAuthorizedSender: auth.isAuthorizedSender,
      roleIds: ctx.MemberRoleIds,
      conversationId: ctx.NativeChannelId ?? ctx.OriginatingTo ?? auth.to ?? auth.from,
      parentConversationId: ctx.ThreadParentId,
      threadId: resolveCommandAuthorizationThreadId(ctx),
    },
  });
  if (!policyContext) {
    return { handled: true, aborted: false, rejectionReason: "policy-denied" };
  }
  const policyDenial = await runAuthorizationPolicies({
    request: {
      operation: "command.invoke",
      phase: "final",
      commandName: "stop",
      owner: { kind: "core" },
      source: normalizeAuthorizationCommandSource(ctx.CommandSource),
    },
    context: policyContext,
    config: cfg,
  });
  if (policyDenial) {
    return { handled: true, aborted: false, rejectionReason: "policy-denied" };
  }
  const targetStillCurrent =
    Array.from(sessionSnapshots.values()).every((snapshot) =>
      fastAbortSessionSnapshotMatchesCurrent(snapshot, cfg, { allowEnded: false }),
    ) &&
    acpSnapshots.every((snapshot) =>
      fastAbortAcpSnapshotMatchesCurrent({ acpManager, cfg, snapshot }),
    );
  if (!targetStillCurrent) {
    return { handled: true, aborted: false, rejectionReason: "finalizing" };
  }
  const abortKey = targetKey ?? auth.from ?? auth.to;
  const requesterSessionKey = targetKey ?? ctx.SessionKey ?? abortKey;

  if (targetKey && storePath) {
    const abortCutoffForTarget = (target: SessionAbortTargetContext): AbortCutoff | undefined =>
      shouldPersistAbortCutoff({
        commandSessionKey,
        targetSessionKey: target.sessionKey,
      })
        ? resolveAbortCutoffFromContext(ctx)
        : undefined;
    let aborted = false;
    let activeAbortRejected = false;
    let exactReplacementObserved = false;
    for (const abortTargetKey of [...abortTargetKeys, sourceAbortKey]) {
      if (!abortTargetKey) {
        continue;
      }
      const snapshot = sessionSnapshots.get(abortTargetKey);
      if (!snapshot) {
        exactReplacementObserved = true;
        continue;
      }
      const outcome = abortFastSessionSnapshot(snapshot);
      activeAbortRejected ||= outcome.active && !outcome.aborted;
      exactReplacementObserved ||= outcome.replacementObserved;
      aborted = outcome.aborted || aborted;
    }
    const replacementObserved =
      exactReplacementObserved ||
      Array.from(sessionSnapshots.values()).some(
        (snapshot) =>
          !fastAbortSessionSnapshotMatchesCurrent(snapshot, cfg, {
            allowEnded: true,
          }),
      );
    if (replacementObserved) {
      // A captured sibling may already be stopped, but shared queue/store effects
      // must not cross into a replacement. Report a retryable target change.
      return {
        handled: true,
        aborted: false,
        rejectionReason: "finalizing",
      };
    }
    const cleared = clearSessionQueues(
      Array.from(sessionSnapshots.values()).flatMap((snapshot) => [
        snapshot.key,
        snapshot.activeSessionId,
        snapshot.replySessionId,
        snapshot.storedSessionId,
      ]),
    );
    if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
      logVerbose(
        `abort: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
      );
    }
    const { stopped } = stopSubagentsForRequester({ cfg, requesterSessionKey });
    if (activeAbortRejected && !aborted) {
      return {
        handled: true,
        aborted: false,
        rejectionReason: "finalizing",
        stoppedSubagents: stopped,
      };
    }
    for (const snapshot of acpSnapshots) {
      if (!snapshot.expectedTarget) {
        logVerbose(`abort: ACP cancel skipped for ${snapshot.key}: session identity unavailable`);
        continue;
      }
      try {
        const cancelled = await acpManager.cancelSession({
          cfg,
          sessionKey: snapshot.key,
          reason: "fast-abort",
          expectedTarget: snapshot.expectedTarget,
        });
        if (!cancelled) {
          logVerbose(`abort: ACP cancel skipped for ${snapshot.key}: session changed`);
        }
      } catch (error) {
        logVerbose(`abort: ACP cancel failed for ${snapshot.key}: ${formatErrorMessage(error)}`);
      }
    }
    let persistedAbortTarget: SessionAbortTargetResult | null = null;
    try {
      persistedAbortTarget = await abortDeps.markSessionAbortTarget({
        ...(primarySessionSnapshot?.storedSessionId
          ? { expectedSessionId: primarySessionSnapshot.storedSessionId }
          : {}),
        scope: {
          agentId,
          sessionKey: targetKey,
          storePath,
        },
        resolveAbortCutoff: abortCutoffForTarget,
      });
    } catch (error) {
      logVerbose(
        `abort: failed to persist abort metadata for ${targetKey}: ${formatErrorMessage(error)}`,
      );
    }
    if (persistedAbortTarget?.persisted === false) {
      logVerbose(
        `abort: failed to persist abort metadata for ${targetKey}: ${persistedAbortTarget.persistenceError ?? "unknown error"}`,
      );
    }
    const abortMemoryKey =
      persistedAbortTarget?.sessionKey ?? resolvedAbortTarget?.sessionKey ?? abortKey;
    const hasAbortTargetEntry = Boolean(persistedAbortTarget?.entry ?? resolvedAbortTarget?.entry);
    if (persistedAbortTarget?.persisted !== true && abortMemoryKey && !hasAbortTargetEntry) {
      setAbortMemory(abortMemoryKey, true);
    }
    return { handled: true, aborted, stoppedSubagents: stopped };
  }

  if (abortKey) {
    setAbortMemory(abortKey, true);
  }
  const { stopped } = stopSubagentsForRequester({ cfg, requesterSessionKey });
  return { handled: true, aborted: false, stoppedSubagents: stopped };
}
