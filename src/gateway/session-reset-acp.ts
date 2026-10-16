// ACP cleanup deadlines and fresh metadata preparation for Gateway reset/delete.
import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { raceWithTimeout } from "../../packages/retry/src/index.js";
import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import { getAcpSessionResetControls } from "../acp/control-plane/manager.reset-controls.js";
import { isAcpOwnerRepairRequired } from "../acp/control-plane/manager.runtime-owner.js";
import { tryPrepareFreshManagerRuntimeSession } from "../acp/control-plane/manager.runtime-resume-state.js";
import { resolveAcpSessionTarget } from "../acp/control-plane/manager.utils.js";
import { getAcpRuntimeBackend } from "../acp/runtime/registry.js";
import {
  listAcpSessionEntries,
  readAcpSessionMetaAsync,
  upsertAcpSessionMeta,
} from "../acp/runtime/session-meta.js";
import type { SessionAcpMeta } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logVerbose } from "../globals.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
const ACP_RUNTIME_CLEANUP_TIMEOUT_MS = 15_000;
async function runAcpCleanupStep(
  op: () => Promise<void>,
): Promise<{ status: "ok" } | { status: "timeout" } | { status: "error"; error: unknown }> {
  return raceWithTimeout(
    () =>
      op()
        .then(() => ({ status: "ok" as const }))
        .catch((error: unknown) => ({ status: "error" as const, error })),
    ACP_RUNTIME_CLEANUP_TIMEOUT_MS,
    () => ({ status: "timeout" as const }),
  );
}

export async function closeAcpRuntimeForSession(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  fallbackSessionKeys?: Array<string | undefined>;
  reason: "session-reset" | "session-delete";
  deferResetState?: boolean;
  onDeferredResetState?: (params: { sessionKey: string; meta: SessionAcpMeta }) => void;
  assertCurrent?: () => void;
}) {
  params.assertCurrent?.();
  const readMeta = (sessionKey: string) =>
    readAcpSessionMetaAsync({
      sessionKey,
      agentId: params.agentId,
      cfg: params.cfg,
      assertCurrent: params.assertCurrent,
    });
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
    acpMeta = await readMeta(sessionKey);
    params.assertCurrent?.();
    if (acpMeta) {
      acpSessionKey = sessionKey;
      break;
    }
  }
  if (!acpMeta) {
    return undefined;
  }
  const acpManager = getAcpSessionManager();
  params.assertCurrent?.();
  const resetControls = getAcpSessionResetControls(acpManager);
  const ownership = resetControls.captureSessionRuntimeOwnership({
    cfg: params.cfg,
    sessionKey: acpSessionKey,
    agentId: params.agentId,
  });
  try {
    const target = {
      cfg: params.cfg,
      sessionKey: acpSessionKey,
      agentId: params.agentId,
      reason: params.reason,
    };
    for (const step of ["cancel", "runtime close"] as const) {
      params.assertCurrent?.();
      const outcome = await runAcpCleanupStep(async () => {
        if (step === "cancel") {
          await acpManager.cancelSession(target);
        } else {
          await acpManager.closeSession({
            ...target,
            discardPersistentState: true,
            requireAcpSession: false,
            allowBackendUnavailable: true,
          });
        }
      });
      params.assertCurrent?.();
      if (outcome.status === "timeout") {
        await resetControls.forceDiscardSessionRuntime({
          ...target,
          isCurrent: ownership.isCurrent,
          assertCurrent: params.assertCurrent,
        });
        params.assertCurrent?.();
        break;
      }
      if (outcome.status === "error") {
        if (isAcpOwnerRepairRequired(outcome.error)) {
          return errorShape(ErrorCodes.UNAVAILABLE, String(outcome.error));
        }
        logVerbose(
          `sessions.${params.reason}: ACP ${step} failed for ${params.sessionKey}: ${String(outcome.error)}`,
        );
      }
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
      const latestMeta = (await readMeta(acpSessionKey)) ?? acpMeta;
      params.assertCurrent?.();
      if (
        !latestMeta.identity ||
        latestMeta.identity.state !== "resolved" ||
        (!latestMeta.identity.acpxSessionId && !latestMeta.identity.agentSessionId)
      ) {
        return undefined;
      }

      // Ownership repair failures must reach the caller before metadata is cleared.
      await tryPrepareFreshManagerRuntimeSession({
        deps: { getRuntimeBackend: getAcpRuntimeBackend },
        cfg: params.cfg,
        meta: latestMeta,
        ...resolveAcpSessionTarget({
          cfg: params.cfg,
          sessionKey: acpSessionKey,
          agentId: params.agentId,
        }),
        logPrefix: "sessions.session-reset",
      });
      params.assertCurrent?.();

      const now = Date.now();
      await upsertAcpSessionMeta({
        cfg: params.cfg,
        sessionKey: acpSessionKey,
        agentId: params.agentId,
        assertCommitAllowed: params.assertCurrent,
        mutate: (current) => {
          params.assertCurrent?.();
          return buildPendingAcpMeta(current ?? latestMeta, now);
        },
      });
      params.assertCurrent?.();
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
}): Promise<void> {
  // ACP children may belong to another agent. Keep each canonical owner while
  // enumerating metadata; combining stores by bare key would collapse owners.
  let children: Array<{ sessionKey: string; agentId?: string }>;
  try {
    params.assertCurrent?.();
    children = (await listAcpSessionEntries({ cfg: params.cfg })).filter(
      ({ entry, sessionKey }) => {
        if (
          !entry ||
          (entry.spawnedBy !== params.parentKey && entry.parentSessionKey !== params.parentKey)
        ) {
          return false;
        }
        const requesterAgentId =
          entry.createdVia === "spawn" && entry.createdActor?.type === "agent"
            ? entry.createdActor.id
            : parseAgentSessionKey(params.parentKey)?.agentId;
        try {
          if (!requesterAgentId) {
            throw new Error("ACP parent ownership is not recorded for this unqualified key");
          }
          const parent = resolveAcpSessionTarget({
            cfg: params.cfg,
            sessionKey: params.parentKey,
            agentId: requesterAgentId,
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
  params.assertCurrent?.();
  await Promise.allSettled(
    children.map(({ sessionKey, agentId }) =>
      closeAcpRuntimeForSession({
        cfg: params.cfg,
        sessionKey,
        agentId,
        reason: params.reason,
        assertCurrent: params.assertCurrent,
      }).then((childError) => {
        if (childError) {
          logVerbose(`sessions.${params.reason}: child ACP cleanup incomplete for ${sessionKey}`);
        }
      }),
    ),
  );
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
