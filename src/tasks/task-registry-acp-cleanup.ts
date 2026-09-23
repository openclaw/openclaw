import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { acpSessionActorKey, resolveAcpSessionTarget } from "../acp/control-plane/manager.utils.js";
import type {
  listAcpSessionEntries,
  readAcpSessionEntry,
  AcpSessionStoreEntry,
} from "../acp/runtime/session-meta.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { getSessionBindingService } from "../infra/outbound/session-binding-service.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { hasActiveTaskForChildSessionKey } from "./task-registry-query.js";
import type { TaskRecord } from "./task-registry.types.js";

const log = createSubsystemLogger("tasks/task-registry-maintenance");

export type CloseAcpSession = (params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  reason: string;
}) => Promise<void>;

export type TaskRegistryAcpMaintenanceRuntime = {
  listAcpSessionEntries: typeof listAcpSessionEntries;
  readAcpSessionEntry: typeof readAcpSessionEntry;
  loadCloseAcpSession?: () => Promise<CloseAcpSession | undefined>;
  listSessionBindingsBySession?: ReturnType<typeof getSessionBindingService>["listBySession"];
  unbindSessionBindings?: ReturnType<typeof getSessionBindingService>["unbind"];
  hasActiveTaskForChildSessionKey: typeof hasActiveTaskForChildSessionKey;
};

export async function loadTaskAcpSessionCloser(): Promise<CloseAcpSession> {
  const { getAcpSessionManager } = await import("../acp/control-plane/manager.js");
  return async ({ cfg, sessionKey, agentId, reason }) => {
    await getAcpSessionManager().closeSession({
      cfg,
      sessionKey,
      agentId,
      reason,
      discardPersistentState: true,
      clearMeta: true,
      allowBackendUnavailable: true,
      requireAcpSession: false,
    });
  };
}

function getNormalizedTaskChildSessionKey(task: TaskRecord): string | undefined {
  return normalizeOptionalString(task.childSessionKey);
}

function getAcpSessionParentKeys(acpEntry: Pick<AcpSessionStoreEntry, "entry">): string[] {
  return [
    normalizeOptionalString(acpEntry.entry?.spawnedBy),
    normalizeOptionalString(acpEntry.entry?.parentSessionKey),
  ].filter((value): value is string => Boolean(value));
}

function isParentOwnedAcpSessionTask(
  task: TaskRecord,
  acpEntry: ReturnType<typeof readAcpSessionEntry>,
): boolean {
  const entry = acpEntry?.entry;
  if (!entry) {
    return false;
  }
  const ownerKey = normalizeOptionalString(task.ownerKey);
  const requesterKey = normalizeOptionalString(task.requesterSessionKey);
  const parentKeys = getAcpSessionParentKeys({ entry });
  return parentKeys.some((parentKey) => parentKey === ownerKey || parentKey === requesterKey);
}

function isParentOwnedAcpSessionEntry(acpEntry: Pick<AcpSessionStoreEntry, "entry">): boolean {
  return getAcpSessionParentKeys(acpEntry).length > 0;
}

function hasActiveSessionBinding(
  runtime: TaskRegistryAcpMaintenanceRuntime,
  sessionKey: string,
): boolean {
  const listBindings = runtime.listSessionBindingsBySession;
  if (!listBindings) {
    return true;
  }
  try {
    return listBindings(sessionKey).some((binding) => binding.status !== "ended");
  } catch {
    return true;
  }
}

function shouldCloseTerminalAcpSession(
  runtime: TaskRegistryAcpMaintenanceRuntime,
  task: TaskRecord,
): boolean {
  if (task.runtime !== "acp" || task.status === "queued" || task.status === "running") {
    return false;
  }
  const sessionKey = getNormalizedTaskChildSessionKey(task);
  if (
    !sessionKey ||
    runtime.hasActiveTaskForChildSessionKey({
      sessionKey,
      agentId: task.agentId,
      excludeTaskId: task.taskId,
    })
  ) {
    return false;
  }
  const acpEntry = runtime.readAcpSessionEntry({
    sessionKey,
    agentId: task.agentId,
    clone: false,
  });
  if (!acpEntry || acpEntry.storeReadFailed || !acpEntry.acp) {
    return false;
  }
  if (!isParentOwnedAcpSessionTask(task, acpEntry)) {
    return false;
  }
  if (acpEntry.acp.mode === "oneshot") {
    return true;
  }
  return !hasActiveSessionBinding(runtime, sessionKey);
}

function shouldCloseOrphanedParentOwnedAcpSession(
  runtime: TaskRegistryAcpMaintenanceRuntime,
  acpEntry: AcpSessionStoreEntry,
): boolean {
  if (!acpEntry.entry || !acpEntry.acp || !isParentOwnedAcpSessionEntry(acpEntry)) {
    return false;
  }
  const sessionKey = normalizeOptionalString(acpEntry.sessionKey);
  if (
    !sessionKey ||
    runtime.hasActiveTaskForChildSessionKey({
      sessionKey,
      agentId: acpEntry.agentId,
    })
  ) {
    return false;
  }
  if (acpEntry.acp.mode === "oneshot") {
    return true;
  }
  return !hasActiveSessionBinding(runtime, sessionKey);
}

export async function cleanupTerminalAcpSession(
  runtime: TaskRegistryAcpMaintenanceRuntime,
  task: TaskRecord,
  closeAcpSession: CloseAcpSession | undefined,
  assertOwnerCurrent: () => void,
): Promise<void> {
  assertOwnerCurrent();
  if (!shouldCloseTerminalAcpSession(runtime, task)) {
    return;
  }
  const sessionKey = getNormalizedTaskChildSessionKey(task);
  if (!sessionKey) {
    return;
  }
  const acpEntry = runtime.readAcpSessionEntry({
    sessionKey,
    agentId: task.agentId,
    clone: false,
  });
  if (!acpEntry || !closeAcpSession) {
    return;
  }
  assertOwnerCurrent();
  try {
    await closeAcpSession({
      cfg: acpEntry.cfg,
      agentId: acpEntry.agentId,
      sessionKey,
      reason: "terminal-task-cleanup",
    });
  } catch (error) {
    assertOwnerCurrent();
    log.warn("Failed to close terminal ACP session during task maintenance", {
      sessionKey,
      taskId: task.taskId,
      error,
    });
    return;
  }
  assertOwnerCurrent();
  try {
    await runtime.unbindSessionBindings?.({
      targetSessionKey: sessionKey,
      reason: "terminal-task-cleanup",
    });
  } catch (error) {
    assertOwnerCurrent();
    log.warn("Failed to unbind terminal ACP session during task maintenance", {
      sessionKey,
      taskId: task.taskId,
      error,
    });
    return;
  }
  assertOwnerCurrent();
}

export async function cleanupOrphanedParentOwnedAcpSessions(
  runtime: TaskRegistryAcpMaintenanceRuntime,
  closeAcpSession: CloseAcpSession | undefined,
  assertOwnerCurrent: () => void,
): Promise<void> {
  assertOwnerCurrent();
  let acpSessions: AcpSessionStoreEntry[];
  try {
    acpSessions = await runtime.listAcpSessionEntries({ clone: false });
  } catch (error) {
    assertOwnerCurrent();
    log.warn("Failed to list ACP sessions during task maintenance", { error });
    return;
  }
  assertOwnerCurrent();
  const seenSessionKeys = new Set<string>();
  for (const acpEntry of acpSessions) {
    const sessionKey = normalizeOptionalString(acpEntry.sessionKey);
    if (!sessionKey) {
      continue;
    }
    const actorKey = acpSessionActorKey(
      resolveAcpSessionTarget({ cfg: acpEntry.cfg, sessionKey, agentId: acpEntry.agentId }),
    );
    if (seenSessionKeys.has(actorKey)) {
      continue;
    }
    seenSessionKeys.add(actorKey);
    if (!shouldCloseOrphanedParentOwnedAcpSession(runtime, acpEntry)) {
      continue;
    }
    if (!closeAcpSession) {
      continue;
    }
    assertOwnerCurrent();
    try {
      await closeAcpSession({
        cfg: acpEntry.cfg,
        agentId: acpEntry.agentId,
        sessionKey,
        reason: "orphaned-parent-task-cleanup",
      });
    } catch (error) {
      assertOwnerCurrent();
      log.warn("Failed to close orphaned parent-owned ACP session during task maintenance", {
        sessionKey,
        error,
      });
      continue;
    }
    assertOwnerCurrent();
    try {
      await runtime.unbindSessionBindings?.({
        targetSessionKey: sessionKey,
        reason: "orphaned-parent-task-cleanup",
      });
    } catch (error) {
      assertOwnerCurrent();
      log.warn("Failed to unbind orphaned parent-owned ACP session during task maintenance", {
        sessionKey,
        error,
      });
      continue;
    }
    assertOwnerCurrent();
  }
}
