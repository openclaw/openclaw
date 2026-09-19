// ACP cleanup deadlines and fresh metadata preparation for Gateway reset/delete.
import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import { getAcpSessionResetControls } from "../acp/control-plane/manager.reset-controls.js";
import { isAcpOwnerRepairRequired } from "../acp/control-plane/manager.runtime-owner.js";
import { tryPrepareFreshManagerRuntimeSession } from "../acp/control-plane/manager.runtime-resume-state.js";
import { resolveAcpSessionTarget } from "../acp/control-plane/manager.utils.js";
import { getAcpRuntimeBackend } from "../acp/runtime/registry.js";
import { readAcpSessionMeta, upsertAcpSessionMeta } from "../acp/runtime/session-meta.js";
import type { SessionAcpMeta } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logVerbose } from "../globals.js";
const ACP_RUNTIME_CLEANUP_TIMEOUT_MS = 15_000;
async function runAcpCleanupStep(params: {
  op: () => Promise<void>;
}): Promise<{ status: "ok" } | { status: "timeout" } | { status: "error"; error: unknown }> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<{ status: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), ACP_RUNTIME_CLEANUP_TIMEOUT_MS);
  });
  const opPromise = params
    .op()
    .then(() => ({ status: "ok" as const }))
    .catch((error: unknown) => ({ status: "error" as const, error }));
  const outcome = await Promise.race([opPromise, timeoutPromise]);
  if (timer) {
    clearTimeout(timer);
  }
  return outcome;
}

export async function closeAcpRuntimeForSession(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  fallbackSessionKeys?: Array<string | undefined>;
  reason: "session-reset" | "session-delete";
  onResetMeta?: (params: { sessionKey: string; meta: SessionAcpMeta }) => void;
  deferResetState?: boolean;
  onDeferredResetState?: (params: { sessionKey: string; meta: SessionAcpMeta }) => void;
  assertCurrent?: () => void;
  shouldCleanup?: () => boolean;
}) {
  if (params.shouldCleanup && !params.shouldCleanup()) {
    return undefined;
  }
  params.assertCurrent?.();
  const sessionKeys = Array.from(
    new Set(
      [params.sessionKey, ...(params.fallbackSessionKeys ?? [])]
        .map((key) => (typeof key === "string" ? key.trim() : ""))
        .filter(Boolean),
    ),
  );
  let acpMeta: SessionAcpMeta | undefined;
  let acpSessionKey = params.sessionKey;
  for (const sessionKey of sessionKeys) {
    acpMeta = readAcpSessionMeta({ sessionKey, agentId: params.agentId, cfg: params.cfg });
    if (acpMeta) {
      acpSessionKey = sessionKey;
      break;
    }
  }
  if (!acpMeta) {
    return undefined;
  }
  const acpManager = getAcpSessionManager();
  if (params.shouldCleanup && !params.shouldCleanup()) {
    return undefined;
  }
  params.assertCurrent?.();
  const resetControls = getAcpSessionResetControls(acpManager);
  const ownership = resetControls.captureSessionRuntimeOwnership({
    cfg: params.cfg,
    sessionKey: acpSessionKey,
    agentId: params.agentId,
  });
  try {
    const cancelOutcome = await runAcpCleanupStep({
      op: async () => {
        await acpManager.cancelSession({
          cfg: params.cfg,
          sessionKey: acpSessionKey,
          agentId: params.agentId,
          reason: params.reason,
        });
      },
    });
    if (params.shouldCleanup && !params.shouldCleanup()) {
      return undefined;
    }
    params.assertCurrent?.();
    if (cancelOutcome.status === "timeout") {
      await resetControls.forceDiscardSessionRuntime({
        cfg: params.cfg,
        sessionKey: acpSessionKey,
        agentId: params.agentId,
        reason: params.reason,
        isCurrent: ownership.isCurrent,
        assertCurrent: params.assertCurrent,
      });
    }
    if (cancelOutcome.status === "error" && isAcpOwnerRepairRequired(cancelOutcome.error)) {
      return errorShape(ErrorCodes.UNAVAILABLE, String(cancelOutcome.error));
    }
    if (cancelOutcome.status === "error") {
      logVerbose(
        `sessions.${params.reason}: ACP cancel failed for ${params.sessionKey}: ${String(cancelOutcome.error)}`,
      );
    }

    if (params.shouldCleanup && !params.shouldCleanup()) {
      return undefined;
    }
    params.assertCurrent?.();
    const closeOutcome =
      cancelOutcome.status === "timeout"
        ? ({ status: "ok" } as const)
        : await runAcpCleanupStep({
            op: async () => {
              await acpManager.closeSession({
                cfg: params.cfg,
                sessionKey: acpSessionKey,
                agentId: params.agentId,
                reason: params.reason,
                discardPersistentState: true,
                requireAcpSession: false,
                allowBackendUnavailable: true,
              });
            },
          });
    if (params.shouldCleanup && !params.shouldCleanup()) {
      return undefined;
    }
    params.assertCurrent?.();
    if (closeOutcome.status === "timeout") {
      await resetControls.forceDiscardSessionRuntime({
        cfg: params.cfg,
        sessionKey: acpSessionKey,
        agentId: params.agentId,
        reason: params.reason,
        isCurrent: ownership.isCurrent,
        assertCurrent: params.assertCurrent,
      });
    }
    if (closeOutcome.status === "error" && isAcpOwnerRepairRequired(closeOutcome.error)) {
      return errorShape(ErrorCodes.UNAVAILABLE, String(closeOutcome.error));
    }
    if (closeOutcome.status === "error") {
      logVerbose(
        `sessions.${params.reason}: ACP runtime close failed for ${params.sessionKey}: ${String(closeOutcome.error)}`,
      );
    }
    if (params.reason === "session-delete") {
      params.assertCurrent?.();
      await upsertAcpSessionMeta({
        cfg: params.cfg,
        sessionKey: acpSessionKey,
        agentId: params.agentId,
        assertCommitAllowed: params.assertCurrent,
        mutate: () => null,
      });
      params.assertCurrent?.();
    } else if (params.deferResetState) {
      params.onDeferredResetState?.({
        sessionKey: acpSessionKey,
        meta: acpMeta,
      });
    } else {
      const resetMeta = await ensureFreshAcpResetState({
        cfg: params.cfg,
        sessionKey: acpSessionKey,
        agentId: params.agentId,
        reason: params.reason,
        acpMeta,
        assertCurrent: params.assertCurrent,
        shouldApply: params.shouldCleanup,
      });
      if (resetMeta) {
        params.onResetMeta?.({ sessionKey: acpSessionKey, meta: resetMeta });
      }
    }
    return undefined;
  } finally {
    ownership.release();
  }
}

export function buildPendingAcpMeta(base: SessionAcpMeta, now: number): SessionAcpMeta {
  const currentIdentity = base.identity;
  const nextIdentity = currentIdentity
    ? {
        state: "pending" as const,
        ...(currentIdentity.acpxRecordId ? { acpxRecordId: currentIdentity.acpxRecordId } : {}),
        source: currentIdentity.source,
        lastUpdatedAt: now,
      }
    : { state: "pending" as const, source: "ensure" as const, lastUpdatedAt: now };
  return {
    backend: base.backend,
    agent: base.agent,
    runtimeSessionName: base.runtimeSessionName,
    ...(nextIdentity ? { identity: nextIdentity } : {}),
    mode: base.mode,
    ...(base.runtimeOptions ? { runtimeOptions: base.runtimeOptions } : {}),
    ...(base.cwd ? { cwd: base.cwd } : {}),
    state: "idle",
    lastActivityAt: now,
  };
}

async function ensureFreshAcpResetState(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  reason: "session-reset" | "session-delete";
  acpMeta: SessionAcpMeta;
  assertCurrent?: () => void;
  shouldApply?: () => boolean;
}): Promise<SessionAcpMeta | undefined> {
  if (params.reason !== "session-reset") {
    return undefined;
  }
  const latestMeta =
    readAcpSessionMeta({
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      cfg: params.cfg,
    }) ?? params.acpMeta;
  if (
    !latestMeta?.identity ||
    latestMeta.identity.state !== "resolved" ||
    (!latestMeta.identity.acpxSessionId && !latestMeta.identity.agentSessionId)
  ) {
    return undefined;
  }

  if (params.shouldApply && !params.shouldApply()) {
    return undefined;
  }
  params.assertCurrent?.();
  // Ownership repair failures must reach the caller before metadata is cleared.
  await tryPrepareFreshManagerRuntimeSession({
    deps: { getRuntimeBackend: getAcpRuntimeBackend },
    cfg: params.cfg,
    meta: latestMeta,
    ...resolveAcpSessionTarget(params),
    logPrefix: `sessions.${params.reason}`,
  });
  if (params.shouldApply && !params.shouldApply()) {
    return undefined;
  }
  params.assertCurrent?.();

  const now = Date.now();
  let resetMeta: SessionAcpMeta | undefined;
  if (params.shouldApply && !params.shouldApply()) {
    return undefined;
  }
  params.assertCurrent?.();
  await upsertAcpSessionMeta({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    mutate: (current) => {
      if (params.shouldApply && !params.shouldApply()) {
        return current;
      }
      resetMeta = buildPendingAcpMeta(current ?? latestMeta, now);
      return resetMeta;
    },
  });
  params.assertCurrent?.();
  return resetMeta;
}
