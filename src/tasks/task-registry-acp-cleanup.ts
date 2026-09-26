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
  const sessionKey = normalizeOptionalString(task.childSessionKey);
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
  if (!acpEntry.entry || !acpEntry.acp || getAcpSessionParentKeys(acpEntry).length === 0) {
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
  const sessionKey = normalizeOptionalString(task.childSessionKey);
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
  return closeAndUnbindAcpSession(runtime, closeAcpSession, assertOwnerCurrent, {
    cfg: acpEntry.cfg,
    agentId: acpEntry.agentId,
    sessionKey,
    taskId: task.taskId,
  });
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
    await closeAndUnbindAcpSession(runtime, closeAcpSession, assertOwnerCurrent, {
      cfg: acpEntry.cfg,
      agentId: acpEntry.agentId,
      sessionKey,
    });
  }
}

async function closeAndUnbindAcpSession(
  runtime: TaskRegistryAcpMaintenanceRuntime,
  closeAcpSession: CloseAcpSession,
  assertOwnerCurrent: () => void,
  target: Pick<AcpSessionStoreEntry, "cfg" | "agentId" | "sessionKey"> & { taskId?: string },
): Promise<void> {
  const { cfg, agentId, sessionKey, taskId } = target;
  const reason = taskId === undefined ? "orphaned-parent-task-cleanup" : "terminal-task-cleanup";
  const description =
    taskId === undefined ? "orphaned parent-owned ACP session" : "terminal ACP session";
  const metadata = { sessionKey, ...(taskId === undefined ? {} : { taskId }) };
  assertOwnerCurrent();
  try {
    await closeAcpSession({ cfg, agentId, sessionKey, reason });
  } catch (error) {
    assertOwnerCurrent();
    log.warn(`Failed to close ${description} during task maintenance`, { ...metadata, error });
    return;
  }
  assertOwnerCurrent();
  try {
    await runtime.unbindSessionBindings?.({ targetSessionKey: sessionKey, reason });
  } catch (error) {
    assertOwnerCurrent();
    log.warn(`Failed to unbind ${description} during task maintenance`, { ...metadata, error });
    return;
  }
  assertOwnerCurrent();
}
