import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { acpSessionActorKey, resolveAcpSessionTarget } from "../acp/control-plane/manager.utils.js";
import {
  matchesAcpSessionControlBinding,
  resolveAcpSessionControlOwner,
  type AcpSessionControlBinding,
} from "../acp/runtime/session-control-owner.js";
import type {
  listAcpSessionEntries,
  readAcpSessionEntryAsync,
  AcpSessionStoreEntry,
} from "../acp/runtime/session-meta.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { getSessionBindingService } from "../infra/outbound/session-binding-service.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { readManagedTaskBacking, readTaskBackingInstance } from "./task-backing-records.js";
import type { TaskRegistryRead } from "./task-registry-read.js";
import type { TaskRecord } from "./task-registry.types.js";
import { resolveTaskSessionAgentId } from "./task-session-identity.js";

const log = createSubsystemLogger("tasks/task-registry-maintenance");

export type CloseAcpSession = (params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  reason: string;
  assertActive: () => void;
  expectedControlBinding: AcpSessionControlBinding;
}) => Promise<void>;

export type TaskRegistryAcpMaintenanceRuntime = {
  listAcpSessionEntries: typeof listAcpSessionEntries;
  readAcpSessionEntryAsync: typeof readAcpSessionEntryAsync;
  loadCloseAcpSession?: () => Promise<CloseAcpSession | undefined>;
  listSessionBindingsBySession?: ReturnType<typeof getSessionBindingService>["listBySession"];
  unbindSessionBindings?: ReturnType<typeof getSessionBindingService>["unbind"];
  prepareTaskRegistryRead: () => Promise<
    | Pick<
        TaskRegistryRead,
        | "assertCurrent"
        | "isTaskCurrent"
        | "isChildSessionCurrent"
        | "getTaskById"
        | "listTaskRecordsForChildSessionKey"
      >
    | undefined
  >;
};

export async function loadTaskAcpSessionCloser(): Promise<CloseAcpSession> {
  const { getAcpSessionManager } = await import("../acp/control-plane/manager.js");
  return async ({ cfg, sessionKey, agentId, reason, assertActive, expectedControlBinding }) => {
    await getAcpSessionManager().closeSession({
      cfg,
      sessionKey,
      agentId,
      reason,
      assertActive,
      expectedControlBinding,
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

function captureAcpSessionControlBinding(
  acpEntry: Pick<AcpSessionStoreEntry, "entry">,
): AcpSessionControlBinding | undefined {
  const entry = acpEntry.entry;
  const ownerKey = resolveAcpSessionControlOwner(entry);
  return entry && ownerKey
    ? {
        sessionId: entry.sessionId,
        lifecycleRevision: entry.lifecycleRevision,
        sessionStartedAt: entry.sessionStartedAt,
        ownerKey,
      }
    : undefined;
}

function isParentOwnedAcpSessionTask(task: TaskRecord, acpEntry: AcpSessionStoreEntry): boolean {
  const ownerKey = resolveAcpSessionControlOwner(acpEntry.entry);
  return Boolean(
    ownerKey &&
    (ownerKey === normalizeOptionalString(task.ownerKey) ||
      ownerKey === normalizeOptionalString(task.requesterSessionKey)),
  );
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

function captureTerminalTask(task: TaskRecord) {
  return {
    taskId: task.taskId,
    runtime: task.runtime,
    status: task.status,
    createdAt: task.createdAt,
    runId: task.runId,
    sourceId: task.sourceId,
    scopeKind: task.scopeKind,
    ownerKey: task.ownerKey,
    requesterSessionKey: task.requesterSessionKey,
    requesterAgentId: task.requesterAgentId,
    agentId: task.agentId,
    childSessionKey: task.childSessionKey,
    parentFlowId: task.parentFlowId,
    backing: readTaskBackingInstance(task.detail),
    managedBacking: readManagedTaskBacking(task.detail),
  };
}

type AcpCleanupRead = NonNullable<
  Awaited<ReturnType<TaskRegistryAcpMaintenanceRuntime["prepareTaskRegistryRead"]>>
>;

function assertChildIdle(read: AcpCleanupRead, sessionKey: string, agentId: string | undefined) {
  read.assertCurrent();
  if (
    !read.isChildSessionCurrent(sessionKey) ||
    read
      .listTaskRecordsForChildSessionKey(sessionKey)
      .some(
        (task) =>
          getNormalizedTaskChildSessionKey(task) === sessionKey &&
          (task.status === "queued" || task.status === "running") &&
          (!agentId || resolveTaskSessionAgentId(task.childSessionKey, task.agentId) === agentId),
      )
  ) {
    throw new Error("ACP session gained active or unsettled task work during cleanup.");
  }
}

function isCleanupEligible(
  runtime: TaskRegistryAcpMaintenanceRuntime,
  entry: AcpSessionStoreEntry | null,
  sessionKey: string,
): entry is AcpSessionStoreEntry {
  return Boolean(
    entry?.entry &&
    !entry.storeReadFailed &&
    entry.acp &&
    resolveAcpSessionControlOwner(entry.entry) &&
    (entry.acp.mode === "oneshot" || !hasActiveSessionBinding(runtime, sessionKey)),
  );
}

async function closeAndUnbindAcpSession(params: {
  runtime: TaskRegistryAcpMaintenanceRuntime;
  entry: AcpSessionStoreEntry;
  sessionKey: string;
  close: CloseAcpSession;
  reason: string;
  assertActive: () => void;
  assertOwnerCurrent: () => void;
}) {
  const expectedControlBinding = captureAcpSessionControlBinding(params.entry);
  if (!expectedControlBinding) {
    return;
  }
  let mode = params.entry.acp?.mode;
  let active = true;
  const assertActive = () => {
    if (!active) {
      throw new Error("ACP cleanup is no longer active.");
    }
    params.assertActive();
    if (mode !== "oneshot" && hasActiveSessionBinding(params.runtime, params.sessionKey)) {
      throw new Error("ACP session acquired an active binding during cleanup.");
    }
  };
  try {
    assertActive();
    await params.close({
      cfg: params.entry.cfg,
      agentId: params.entry.agentId,
      sessionKey: params.sessionKey,
      reason: params.reason,
      assertActive,
      expectedControlBinding,
    });
    assertActive();
    const current = await params.runtime.readAcpSessionEntryAsync({
      cfg: params.entry.cfg,
      agentId: params.entry.agentId,
      sessionKey: params.sessionKey,
      clone: false,
      assertCurrent: assertActive,
    });
    assertActive();
    if (
      current?.storeReadFailed ||
      !matchesAcpSessionControlBinding(current?.entry, expectedControlBinding)
    ) {
      throw new Error("ACP cleanup target changed before unbinding.");
    }
    mode = current?.acp?.mode ?? mode;
    assertActive();
    await params.runtime.unbindSessionBindings?.({
      targetSessionKey: params.sessionKey,
      reason: params.reason,
    });
    assertActive();
  } catch (error) {
    params.assertOwnerCurrent();
    log.warn("ACP session cleanup did not complete", {
      sessionKey: params.sessionKey,
      reason: params.reason,
      error,
    });
  } finally {
    active = false;
  }
}

export async function cleanupTerminalAcpSession(
  runtime: TaskRegistryAcpMaintenanceRuntime,
  task: TaskRecord,
  closeAcpSession: CloseAcpSession | undefined,
  assertOwnerCurrent: () => void,
): Promise<void> {
  assertOwnerCurrent();
  const sessionKey = getNormalizedTaskChildSessionKey(task);
  if (
    !closeAcpSession ||
    !sessionKey ||
    task.runtime !== "acp" ||
    task.status === "queued" ||
    task.status === "running"
  ) {
    return;
  }
  const selected = captureTerminalTask(task);
  const read = await runtime.prepareTaskRegistryRead();
  assertOwnerCurrent();
  if (!read) {
    return;
  }
  const assertActive = () => {
    assertOwnerCurrent();
    assertChildIdle(read, sessionKey, task.agentId);
    const current = read.isTaskCurrent(task.taskId) ? read.getTaskById(task.taskId) : undefined;
    if (!current || !isDeepStrictEqual(captureTerminalTask(current), selected)) {
      throw new Error("Terminal ACP task changed during cleanup.");
    }
  };
  try {
    assertActive();
    const entry = await runtime.readAcpSessionEntryAsync({
      sessionKey,
      agentId: task.agentId,
      clone: false,
      assertCurrent: assertActive,
    });
    assertActive();
    if (
      !isCleanupEligible(runtime, entry, sessionKey) ||
      !isParentOwnedAcpSessionTask(task, entry)
    ) {
      return;
    }
    await closeAndUnbindAcpSession({
      runtime,
      entry,
      sessionKey,
      close: closeAcpSession,
      reason: "terminal-task-cleanup",
      assertActive,
      assertOwnerCurrent,
    });
  } catch (error) {
    assertOwnerCurrent();
    log.warn("Terminal ACP cleanup eligibility changed", {
      sessionKey,
      taskId: task.taskId,
      error,
    });
  }
}

export async function cleanupOrphanedParentOwnedAcpSessions(
  runtime: TaskRegistryAcpMaintenanceRuntime,
  closeAcpSession: CloseAcpSession | undefined,
  assertOwnerCurrent: () => void,
): Promise<void> {
  assertOwnerCurrent();
  if (!closeAcpSession) {
    return;
  }
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
  for (const listed of acpSessions) {
    const sessionKey = normalizeOptionalString(listed.sessionKey);
    if (!sessionKey || !isCleanupEligible(runtime, listed, sessionKey)) {
      continue;
    }
    const actorKey = acpSessionActorKey(
      resolveAcpSessionTarget({ cfg: listed.cfg, sessionKey, agentId: listed.agentId }),
    );
    if (seenSessionKeys.has(actorKey)) {
      continue;
    }
    seenSessionKeys.add(actorKey);
    const read = await runtime.prepareTaskRegistryRead();
    assertOwnerCurrent();
    if (!read) {
      continue;
    }
    const assertActive = () => {
      assertOwnerCurrent();
      assertChildIdle(read, sessionKey, listed.agentId);
    };
    try {
      assertActive();
      const entry = await runtime.readAcpSessionEntryAsync({
        cfg: listed.cfg,
        sessionKey,
        agentId: listed.agentId,
        clone: false,
        assertCurrent: assertActive,
      });
      assertActive();
      const expectedControlBinding = captureAcpSessionControlBinding(listed);
      if (
        !expectedControlBinding ||
        !isCleanupEligible(runtime, entry, sessionKey) ||
        !matchesAcpSessionControlBinding(entry.entry, expectedControlBinding)
      ) {
        continue;
      }
      await closeAndUnbindAcpSession({
        runtime,
        entry,
        sessionKey,
        close: closeAcpSession,
        reason: "orphaned-parent-task-cleanup",
        assertActive,
        assertOwnerCurrent,
      });
    } catch (error) {
      assertOwnerCurrent();
      log.warn("Orphaned ACP cleanup eligibility changed", { sessionKey, error });
    }
  }
}
