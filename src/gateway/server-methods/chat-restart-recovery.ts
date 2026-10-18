import { createHmac } from "node:crypto";
import type { HumanMention } from "../../../packages/gateway-protocol/src/index.js";
import { OPENCLAW_AGENT_RUNTIME_ID } from "../../agents/agent-runtime-id.js";
import { shouldComputeCommandAuthorized } from "../../auto-reply/command-detection.js";
import {
  resolveChannelResetConfig,
  resolveSessionResetType,
  type SessionEntry,
  type InternalSessionEntry,
} from "../../config/sessions.js";
import {
  resolvePreparedSessionEntryResetFreshness,
  resolveSessionEntryResetFreshness,
} from "../../config/sessions/entry-freshness.js";
import type { SessionLifecycleTimestamps } from "../../config/sessions/lifecycle.types.js";
import {
  hasRestartRecoveryTerminalRun,
  isRetryableUnadoptedChatClaim,
} from "../../config/sessions/restart-recovery-state.js";
import type {
  SessionTranscriptTurnExpectedState,
  SessionTranscriptTurnLifecyclePatch,
} from "../../config/sessions/session-accessor.js";
import { applySessionEntryTargetOperation } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionEntryTargetPatchScope } from "../../config/sessions/session-accessor.types.js";
import type { CapturedSessionEntryReadSource } from "../../config/sessions/session-entry-read-source.types.js";
import { buildRestartRecoveryExpectedState } from "../../config/sessions/session-transcript-turn-state.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveProjectedAgentRunProgressState } from "../../infra/agent-run-registry.js";
import { loadOrCreateProcessDeviceIdentityAsync } from "../../infra/device-identity-async.js";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { findRestartRecoveryUnsafeChatAdmissionHook } from "../../plugins/restart-recovery-hook-safety.js";
import { CommandLane } from "../../process/lanes.js";
import {
  isCronSessionKey,
  isIncognitoSessionKey,
  isSubagentSessionKey,
} from "../../routing/session-key.js";
import { isAgentHarnessSessionKey } from "../../sessions/agent-harness-session-key.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  getRpcSourceIdentity,
  listRpcSourceEntries,
} from "../../sessions/session-controller.rpc-sources.js";
import { findSessionControllerEntry } from "../../sessions/session-controller.state.js";
import { isAcpSessionKey, resolveSessionDispatchKind } from "../../sessions/session-key-utils.js";
import { recordGatewaySessionRunFailure } from "../../sessions/session-run-error.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.read.js";
import { parseInlineDirectives } from "../../utils/directive-tags.js";
import { resolveAgentSessionWorkStartError } from "../agent-turn/agent-handler-helpers.js";
import { resolveChatRunOwnerAgentId } from "../chat-run-owner.js";
import type { GatewayRecoveryRuntime } from "../server-instance-runtime.types.js";
import { deriveGatewaySessionLifecycleSnapshot } from "../session-lifecycle-state.js";
import {
  captureGatewayScopeMatcher,
  captureRpcSourceScopeMatcher,
  type SessionRuntimeScope,
} from "../session-runtime-scope.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-record.js";
import type { WorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { boundedWorkerError } from "../worker-environments/worker-error.js";
import type { GatewayRequestContext } from "./types.js";

const RESTART_SAFE_CHAT_REQUEST_VERIFIER_DOMAIN = "openclaw.chat.restart-retry.v1";
const log = createSubsystemLogger("gateway/restart-recovery");

type RestartSafeChatRequest = {
  fingerprint: string;
};

type RestartSafeChatAdmission = {
  priorTerminalSourceRunId?: string;
  requestFingerprint: string;
  retryExpectedState?: SessionTranscriptTurnExpectedState;
};

export type RestartSafeChatTerminalState = {
  error?: string;
  errorKind?: "state_contention";
  retryable: boolean;
  status: "failed" | "killed";
};

type DurableChatClaimResolution =
  | { kind: "continue"; entry?: SessionEntry }
  | { kind: "accepted" }
  | { kind: "pending"; message: string }
  | { kind: "rejected"; message: string; unavailable?: true };

function hasRestartUnsafeMessageSemantics(rawMessage: string, cfg: OpenClawConfig): boolean {
  if (
    shouldComputeCommandAuthorized(rawMessage, cfg) ||
    rawMessage.startsWith("/") ||
    rawMessage.startsWith("!")
  ) {
    return true;
  }
  const directives = parseInlineDirectives(rawMessage, {
    stripAudioTag: false,
    stripReplyTags: false,
  });
  return directives.hasAudioTag || directives.hasReplyTag;
}

async function fingerprintRestartSafeChatRequest(params: {
  message: string;
  mentions?: readonly HumanMention[];
  senderIsOwner: boolean;
}): Promise<string> {
  const identity = await loadOrCreateProcessDeviceIdentityAsync();
  const digest = createHmac("sha256", identity.privateKeyPem)
    .update(
      JSON.stringify([
        RESTART_SAFE_CHAT_REQUEST_VERIFIER_DOMAIN,
        params.message,
        params.senderIsOwner,
        ...(params.mentions?.length
          ? [params.mentions.map(({ profileId, start, end }) => [profileId, start, end])]
          : []),
      ]),
    )
    .digest("hex");
  // The verifier survives a gateway restart without retaining an offline
  // digest of redacted prompt material in the session database.
  return `hmac-sha256:v1:${identity.deviceId}:${digest}`;
}

export async function createRestartSafeChatRequest(params: {
  goalRequestFingerprint?: string;
  eligible: boolean;
  message: string;
  mentions?: readonly HumanMention[];
  senderIsOwner: boolean;
  cfg: OpenClawConfig;
}): Promise<RestartSafeChatRequest | undefined> {
  if (params.goalRequestFingerprint) {
    // Goal admission owns literal intent; slash-looking objectives are not commands.
    // Its receipt fingerprints attachments, routing, and every immutable run option.
    return { fingerprint: params.goalRequestFingerprint };
  }
  if (!params.eligible || hasRestartUnsafeMessageSemantics(params.message, params.cfg)) {
    return undefined;
  }
  return {
    fingerprint: await fingerprintRestartSafeChatRequest(params),
  };
}

function isAdoptedRestartRecoveryClaim(
  entry: SessionEntry | undefined,
  clientRunId: string,
): entry is SessionEntry & {
  restartRecoveryDeliveryRunId: string;
  restartRecoveryDeliverySourceRunId: string;
} {
  return Boolean(
    entry?.restartRecoveryDeliveryRunId &&
    entry.restartRecoveryDeliverySourceRunId === clientRunId &&
    !isRetryableUnadoptedChatClaim(entry, clientRunId),
  );
}

// A resend prepared for this claim already owns its mailbox input; a same-ID
// retry joins that owner instead of dispatching again or reporting it pending.
function hasLiveRestartRecoveryResend(
  entry: SessionEntry,
  params: SessionRuntimeScope & {
    canonicalSessionKey: string;
    clientRunId: string;
    agentId?: string;
  },
): boolean {
  const runId = entry.restartRecoveryDeliveryRunId;
  if (!runId || runId === params.clientRunId) {
    return false;
  }
  const target = captureSessionTarget({
    storeScope: params.storePath,
    sessionKey: params.canonicalSessionKey,
    incarnation: entry.sessionId,
    agentId: params.agentId,
  });
  const controller = findSessionControllerEntry(params.canonicalSessionKey, target);
  const matchesGateway = captureGatewayScopeMatcher(params.resolveGatewayContext);
  return (controller?.mailbox?.entries ?? []).some(
    (input) =>
      input.protocolRunId === runId &&
      matchesGateway(input) &&
      (input.claim?.operation?.sessionId ?? input.sourceSessionId ?? input.target?.incarnation) ===
        entry.sessionId &&
      input.phase !== "consumed" &&
      !input.retirementRequested &&
      !input.custody.cancellationRetired &&
      !input.abortSignal.aborted,
  );
}

export function resolveDurableChatClaim(
  params: SessionRuntimeScope & {
    agentId?: string;
    canonicalSessionKey: string;
    cfg: OpenClawConfig;
    clientRunId: string;
    entry?: SessionEntry;
    persistedSessionKey: string;
    reloadEntry: () => SessionEntry | undefined | Promise<SessionEntry | undefined>;
    recoveryRuntime?: GatewayRecoveryRuntime;
    warn: (message: string) => void;
  },
): DurableChatClaimResolution | Promise<DurableChatClaimResolution> {
  const entry = params.entry;
  if (
    !isAdoptedRestartRecoveryClaim(entry, params.clientRunId) ||
    entry.abortedLastRun !== true ||
    hasLiveRestartRecoveryResend(entry, params)
  ) {
    return isAdoptedRestartRecoveryClaim(entry, params.clientRunId) ||
      hasRestartRecoveryTerminalRun(entry, params.clientRunId)
      ? { kind: "accepted" }
      : { kind: "continue", entry };
  }
  const recoverySessionError = resolveAgentSessionWorkStartError(params.canonicalSessionKey, entry);
  if (recoverySessionError) {
    return { kind: "rejected", message: recoverySessionError };
  }
  const recoveryRuntime = params.recoveryRuntime;
  if (!recoveryRuntime) {
    return {
      kind: "pending",
      message: "accepted chat turn recovery is waiting for the Gateway runtime; retry",
    };
  }
  return (async (): Promise<DurableChatClaimResolution> => {
    try {
      const { retryRestartAbortedMainSessionRecovery } =
        await import("../../agents/main-session-recovery/main-session-restart-recovery.js");
      await retryRestartAbortedMainSessionRecovery({
        canonicalSessionKey: params.canonicalSessionKey,
        cfg: params.cfg,
        lane: CommandLane.Main,
        expectedRecoveryRunId: entry.restartRecoveryDeliveryRunId,
        expectedRecoverySourceRunId: entry.restartRecoveryDeliverySourceRunId,
        expectedSessionId: entry.sessionId,
        sessionKey: params.persistedSessionKey,
        storePath: params.storePath,
        gatewayRuntime: recoveryRuntime,
      });
    } catch (error) {
      params.warn(String(error));
    }
    const current = await params.reloadEntry();
    if (
      isAdoptedRestartRecoveryClaim(current, params.clientRunId) &&
      current.abortedLastRun === true
    ) {
      return {
        kind: "pending",
        message: "accepted chat turn recovery is still pending; retry",
      };
    }
    if (
      !isAdoptedRestartRecoveryClaim(current, params.clientRunId) &&
      !hasRestartRecoveryTerminalRun(current, params.clientRunId)
    ) {
      return {
        kind: "rejected",
        message:
          "accepted chat turn recovery ownership changed; automatic retry stopped to avoid duplicate execution",
        unavailable: true,
      };
    }
    return { kind: "accepted" };
  })();
}

export function isDirectChatGoalSession(params: {
  entry?: SessionEntry;
  acpMeta: SessionEntry["acp"] | null;
  requestedSessionId?: string;
  sessionKey: string;
}): boolean {
  const entry = params.entry;
  return Boolean(
    entry?.sessionId &&
    params.sessionKey !== "global" &&
    entry.abortedLastRun !== true &&
    entry.archivedAt === undefined &&
    entry.initializationPending !== true &&
    entry.pendingFinalDelivery === undefined &&
    entry.pluginOwnerId === undefined &&
    entry.spawnedBy === undefined &&
    entry.subagentRole === undefined &&
    (entry.spawnDepth ?? 0) === 0 &&
    params.acpMeta == null &&
    entry.cronRunContinuation === undefined &&
    !isSubagentSessionKey(params.sessionKey) &&
    !isCronSessionKey(params.sessionKey) &&
    !isAcpSessionKey(params.sessionKey) &&
    !isAgentHarnessSessionKey(params.sessionKey) &&
    (params.requestedSessionId === undefined || params.requestedSessionId === entry.sessionId),
  );
}

function hasRestartUnsafeChatWork(
  params: SessionRuntimeScope & {
    clientRunId: string;
    sessionId: string;
    sessionKey: string;
    agentId: string;
    entry?: SessionEntry;
  },
): boolean {
  const matchesGateway = captureGatewayScopeMatcher(params.resolveGatewayContext);
  const controller = findSessionControllerEntry(
    params.sessionKey,
    captureSessionTarget({
      storeScope: params.storePath,
      sessionKey: params.sessionKey,
      incarnation: params.sessionId,
      agentId: params.agentId,
    }),
  );
  if (
    findRestartRecoveryUnsafeChatAdmissionHook(
      resolveSessionDispatchKind(params.sessionKey, params.entry),
    ) !== undefined ||
    resolveProjectedAgentRunProgressState({
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKeys: [params.sessionKey],
    }) !== undefined ||
    (controller?.active && matchesGateway(controller.active))
  ) {
    return true;
  }
  const matchesScope = captureRpcSourceScopeMatcher(params);
  for (const [runId, active] of listRpcSourceEntries()) {
    if (runId === params.clientRunId || !matchesScope(active)) {
      continue;
    }
    const identity = getRpcSourceIdentity(active);
    if (
      (identity.sessionKey === params.sessionKey || identity.sessionId === params.sessionId) &&
      resolveChatRunOwnerAgentId({
        agentId: identity.agentId,
        sessionKey: identity.sessionKey,
        defaultAgentId: params.agentId,
      }) === params.agentId
    ) {
      return true;
    }
  }
  return false;
}

export type PreparedRestartSafeChatPlacement = {
  sessionId: string;
  facts: Awaited<ReturnType<WorkerSessionPlacementStore["prepareSessionPlacement"]>>;
};

/** Borrow placement facts only while the chat owner revalidates and commits admission. */
export async function withRestartSafeChatPlacement(
  service: NonNullable<GatewayRequestContext["workerSessionPlacementService"]>,
  sessionId: string,
  consume: (prepared: PreparedRestartSafeChatPlacement) => Promise<void>,
): Promise<void> {
  if (!service.prepareSessionPlacement) {
    throw new Error("Worker placement admission reader is unavailable; retry.");
  }
  const facts = await service.prepareSessionPlacement(sessionId);
  try {
    await consume({ sessionId, facts });
  } finally {
    facts.release();
  }
}

export function resolveRestartSafeChatAdmission(
  params: SessionRuntimeScope & {
    agentId: string;
    cfg: OpenClawConfig;
    clientRunId: string;
    context: Pick<GatewayRequestContext, "workerSessionPlacementService">;
    entry?: SessionEntry;
    acpMeta: SessionEntry["acp"] | null;
    initialSessionEntry?: SessionEntry;
    lifecycleTimestamps?: SessionLifecycleTimestamps;
    now: number;
    placement: WorkerSessionPlacementRecord | undefined;
    request?: RestartSafeChatRequest;
    requestedSessionId?: string;
    sessionId: string;
    sessionKey: string;
  },
): RestartSafeChatAdmission | undefined {
  const request = params.request;
  const entry = params.entry ?? params.initialSessionEntry;
  const placement = params.placement;
  // Only local input may be consumed before turn admission. Worker setup and
  // reconciliation retain approved input in custody until their writer is ready.
  if (params.cfg.cloudWorkers?.requiredProfile || (placement && placement.state !== "local")) {
    return undefined;
  }
  if (
    !request ||
    !entry ||
    !isDirectChatGoalSession({ ...params, entry }) ||
    (entry.agentHarnessId !== undefined && entry.agentHarnessId !== OPENCLAW_AGENT_RUNTIME_ID)
  ) {
    return undefined;
  }
  if (!params.initialSessionEntry) {
    const freshnessScope = {
      agentId: params.agentId,
      now: params.now,
      resetOverride: resolveChannelResetConfig({
        sessionCfg: params.cfg.session,
        channel: sessionDeliveryChannel(params.entry),
      }),
      resetType: resolveSessionResetType({ sessionKey: params.sessionKey }),
      sessionCfg: params.cfg.session,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    };
    let freshness: ReturnType<typeof resolvePreparedSessionEntryResetFreshness>;
    if (isIncognitoSessionKey(params.sessionKey)) {
      // Process-held incognito freshness retains its existing native owner.
      freshness = resolveSessionEntryResetFreshness(freshnessScope);
    } else {
      if (params.lifecycleTimestamps === undefined) {
        throw new Error("Restart-safe chat freshness was not prepared; retry.");
      }
      freshness = resolvePreparedSessionEntryResetFreshness(
        freshnessScope,
        entry,
        params.lifecycleTimestamps,
      );
    }
    if (freshness.state !== "fresh") {
      return undefined;
    }
  }
  if (hasRestartUnsafeChatWork(params)) {
    return undefined;
  }
  const retryableClaim = isRetryableUnadoptedChatClaim(entry, params.clientRunId);
  if (retryableClaim && entry.restartRecoveryDeliveryRequestFingerprint !== request.fingerprint) {
    throw new Error("chat retry does not match its durable admission");
  }
  return {
    requestFingerprint: request.fingerprint,
    ...(retryableClaim
      ? {
          retryExpectedState: buildRestartRecoveryExpectedState(entry),
        }
      : entry.restartRecoveryDeliverySourceRunId
        ? { priorTerminalSourceRunId: entry.restartRecoveryDeliverySourceRunId }
        : {}),
  };
}

export function buildRestartSafeChatTranscriptState(params: {
  admission: RestartSafeChatAdmission;
  clientRunId: string;
  startedAt: number;
  sourceIngress: "control-ui" | "internal";
  lastInteractionAt?: number;
  operatorSource?: InternalSessionEntry["restartRecoveryOperatorSource"];
}): {
  expectedSessionState?: SessionTranscriptTurnExpectedState;
  sessionLifecyclePatch: SessionTranscriptTurnLifecyclePatch;
} {
  return {
    ...(params.admission.retryExpectedState
      ? { expectedSessionState: params.admission.retryExpectedState }
      : {}),
    sessionLifecyclePatch: {
      // The runner records `pending` only while a hook is executing. With no
      // checkpoint, recovery simply re-enters the normal agent hook pipeline.
      restartRecoveryBeforeAgentReplyState: undefined,
      restartRecoveryDeliveryReceiptState: undefined,
      restartRecoveryDeliveryToolCallId: undefined,
      ...deriveGatewaySessionLifecycleSnapshot({
        event: { runId: params.clientRunId, ts: params.startedAt, data: { phase: "start" } },
      }),
      lifecycleRunId: params.clientRunId,
      ...(params.lastInteractionAt !== undefined
        ? { lastInteractionAt: params.lastInteractionAt }
        : {}),
      lastRunId: undefined,
      restartRecoveryDeliveryContext: undefined,
      restartRecoveryDeliveryRequestFingerprint: params.admission.requestFingerprint,
      restartRecoveryDeliveryRunId: params.clientRunId,
      restartRecoveryDeliverySourceRunId: params.clientRunId,
      restartRecoveryRequesterAccountId: undefined,
      restartRecoveryRequesterSenderId: undefined,
      restartRecoverySameChannelThreadRequired: undefined,
      restartRecoverySourceIngress: params.sourceIngress,
      restartRecoveryOperatorSource: params.admission.retryExpectedState
        ? params.admission.retryExpectedState.restartRecoveryOperatorSource
        : params.operatorSource,
      restartRecoverySourceReplyDeliveryMode: undefined,
      ...(params.admission.priorTerminalSourceRunId
        ? { restartRecoveryTerminalRunIds: [params.admission.priorTerminalSourceRunId] }
        : {}),
    },
  };
}

export async function terminalizeRestartSafeChatAdmission(
  params: RestartSafeChatTerminalState & {
    admittedSessionId: string;
    clientRunId: string;
    expectedLifecycleRevision: string | undefined;
    target: SessionEntryTargetPatchScope & { readSource: CapturedSessionEntryReadSource };
    assertCurrent: () => void;
    startedAt: number;
  },
): Promise<boolean> {
  const endedAt = Date.now();
  let terminalized = false;
  params.assertCurrent();
  const persisted = await applySessionEntryTargetOperation(
    params.target,
    {
      kind: "restart-safe-terminal",
      runId: params.clientRunId,
      retryable: params.retryable,
      expected: {
        sessionId: params.admittedSessionId,
        lifecycleRevision: params.expectedLifecycleRevision,
      },
      // Sanitize on the host; the writer commits this diagnostic with exact claim cleanup.
      patch: {
        ...deriveGatewaySessionLifecycleSnapshot({
          event: {
            runId: params.clientRunId,
            ts: endedAt,
            data: {
              phase: params.status === "failed" ? "error" : "end",
              startedAt: params.startedAt,
              endedAt,
              aborted: params.status === "killed",
              error: params.error,
              errorKind: params.errorKind,
            },
          },
        }),
        abortedLastRun: params.retryable ? false : params.status === "killed",
        lifecycleRunId: undefined,
        lastRunId: params.clientRunId,
      },
    },
    {
      requireWriteSuccess: true,
      skipMaintenance: true,
      workerGuard: { assertCurrent: params.assertCurrent },
      onCommitted: () => {
        terminalized = true;
      },
    },
  );
  if (terminalized && persisted && params.status === "failed") {
    await recordGatewaySessionRunFailure({
      target: {
        agentId: params.target.agentId,
        env: params.target.env,
        sessionKey: params.target.target.canonicalKey,
        storePath: params.target.readSource.path,
        sessionId: persisted.sessionId,
        expectedLifecycleRevision: persisted.lifecycleRevision,
      },
      runId: params.clientRunId,
      error: params.error,
      errorKind: params.errorKind,
      assertCommitAllowed: () => {
        params.assertCurrent();
        const source = params.target.readSource;
        if (
          !isIncognitoSessionKey(params.target.target.canonicalKey) &&
          typeof source.databaseIdentity === "string"
        ) {
          assertExistingDatabaseIdentity(
            source.path,
            `file:${source.databaseIdentity}`,
            source.databaseBirthtime,
          );
        }
      },
    }).catch((error: unknown) => {
      // The claim is already settled; report failure must not trigger a competing terminal write.
      log.warn(`Failed to record restart-safe chat failure notice: ${boundedWorkerError(error)}`);
    });
  }
  return terminalized;
}
