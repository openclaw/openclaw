// ACP cleanup deadlines and fresh metadata preparation for Gateway reset/delete.
import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import { getAcpSessionResetControls } from "../acp/control-plane/manager.reset-controls.js";
import { isAcpOwnerRepairRequired } from "../acp/control-plane/manager.runtime-owner.js";
import { tryPrepareFreshManagerRuntimeSession } from "../acp/control-plane/manager.runtime-resume-state.js";
import { resolveAcpSessionTarget } from "../acp/control-plane/manager.utils.js";
import { getAcpRuntimeBackend } from "../acp/runtime/registry.js";
import {
  listAcpSessionEntries,
  readAcpSessionMeta,
  upsertAcpSessionMeta,
} from "../acp/runtime/session-meta.js";
import type { SessionAcpMeta } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logVerbose } from "../globals.js";
import { listTasksForRelatedSessionKey } from "../tasks/task-registry-query.js";
const ACP_RUNTIME_CLEANUP_TIMEOUT_MS = 15_000;
async function runAcpCleanupStep(
  op: () => Promise<void>,
): Promise<{ status: "ok" } | { status: "timeout" } | { status: "error"; error: unknown }> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<{ status: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), ACP_RUNTIME_CLEANUP_TIMEOUT_MS);
  });
  const opPromise = op()
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
    const cancelOutcome = await runAcpCleanupStep(async () => {
      await acpManager.cancelSession({
        cfg: params.cfg,
        sessionKey: acpSessionKey,
        agentId: params.agentId,
        reason: params.reason,
      });
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
        : await runAcpCleanupStep(async () => {
            await acpManager.closeSession({
              cfg: params.cfg,
              sessionKey: acpSessionKey,
              agentId: params.agentId,
              reason: params.reason,
              discardPersistentState: true,
              requireAcpSession: false,
              allowBackendUnavailable: true,
            });
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
export async function closeChildAcpRuntimesForParent(params: {
  cfg: OpenClawConfig;
  parentKey: string;
  parentAgentId?: string;
  reason: "session-reset" | "session-delete";
  assertCurrent?: () => void;
  shouldCleanup?: () => boolean;
}): Promise<void> {
  // ACP children may belong to another agent. Keep each canonical owner while
  // enumerating metadata; combining stores by bare key would collapse owners.
  let children: Array<{ sessionKey: string; agentId?: string }>;
  try {
    if (params.shouldCleanup && !params.shouldCleanup()) {
      return;
    }
    params.assertCurrent?.();
    children = (await listAcpSessionEntries({ cfg: params.cfg })).filter(
      ({ entry, sessionKey, agentId }) => {
        if (entry?.spawnedBy !== params.parentKey && entry?.parentSessionKey !== params.parentKey) {
          return false;
        }
        const requesterOwners = new Set(
          listTasksForRelatedSessionKey(sessionKey)
            .filter(
              (task) =>
                task.runtime === "acp" &&
                task.childSessionKey === sessionKey &&
                task.agentId === agentId &&
                (task.requesterSessionKey === params.parentKey ||
                  task.ownerKey === params.parentKey),
            )
            .flatMap((task) => (task.requesterAgentId ? [task.requesterAgentId] : [])),
        );
        try {
          if (requesterOwners.size > 1) {
            throw new Error("ACP parent ownership is ambiguous");
          }
          const parent = resolveAcpSessionTarget({
            cfg: params.cfg,
            sessionKey: params.parentKey,
            agentId: requesterOwners.values().next().value,
          });
          return parent.agentId === params.parentAgentId;
        } catch (error) {
          logVerbose(
            `sessions.${params.reason}: retained ACP child ${sessionKey} because parent ownership could not be proven: ${String(error)}`,
          );
          return false;
        }
      },
    );
  } catch (error) {
    logVerbose(
      `sessions.${params.reason}: failed to enumerate sessions for child ACP cleanup: ${String(error)}`,
    );
    return;
  }
  // Close only direct ACP-backed children of the session being mutated; the
  // parent itself is closed separately by the caller. Without this, child ACP
  // sessions spawned via sessions_spawn are orphaned on parent reset/delete.
  // Close children concurrently so total latency is bounded by a single ACP
  // cleanup timeout window rather than scaling with the number of stuck
  // children; per-child failures are logged best-effort and never propagated,
  // so a stuck child cannot block or fail the parent mutation.
  if (params.shouldCleanup && !params.shouldCleanup()) {
    return;
  }
  params.assertCurrent?.();
  await Promise.allSettled(
    children.map(({ sessionKey, agentId }) =>
      closeAcpRuntimeForSession({
        cfg: params.cfg,
        sessionKey,
        agentId,
        reason: params.reason,
        assertCurrent: params.assertCurrent,
        shouldCleanup: params.shouldCleanup,
      }).then((childError) => {
        if (childError) {
          logVerbose(`sessions.${params.reason}: child ACP cleanup incomplete for ${sessionKey}`);
        }
      }),
    ),
  );
  if (params.shouldCleanup && !params.shouldCleanup()) {
    return;
  }
  params.assertCurrent?.();
}

export function buildPendingAcpMeta(base: SessionAcpMeta, now: number): SessionAcpMeta {
  const currentIdentity = base.identity;
  return {
    backend: base.backend,
    agent: base.agent,
    runtimeSessionName: base.runtimeSessionName,
    identity: {
      state: "pending",
      ...(currentIdentity?.acpxRecordId ? { acpxRecordId: currentIdentity.acpxRecordId } : {}),
      source: currentIdentity ? currentIdentity.source : "ensure",
      lastUpdatedAt: now,
    },
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
