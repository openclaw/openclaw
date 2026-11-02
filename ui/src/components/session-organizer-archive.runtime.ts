import type { GatewaySessionRow } from "../api/types.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { t } from "../i18n/index.ts";
import { registerSessionMenuEnglish } from "../i18n/locales/en-session-menu.ts";
import { registerSessionOrganizationEnglish } from "../i18n/locales/en-session-organization.ts";
import { formatUiError } from "../lib/format-error.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import { fetchChildSessionRows } from "../lib/sessions/child-session-data.ts";
import { customSnoozeStorageKey, rememberCustomSnooze } from "../lib/sessions/custom-snooze.ts";
import { resolveUiSessionRowAgentId, isSubagentSessionKey } from "../lib/sessions/session-key.ts";
import { formatSessionSnoozeWakeTime } from "../lib/sessions/session-snooze.ts";
import { showToast } from "../lib/toast.ts";
import type {
  SidebarSessionMutationResult,
  SidebarSessionMutationScope,
} from "./app-sidebar-session-types.ts";
import { showConfirmChoiceDialog, showConfirmDialog } from "./confirm-dialog.ts";
import {
  confirmWithBoundAutomations,
  withBoundAutomationNotice,
} from "./session-automation-confirm.ts";
import { isSessionMutationScopeCurrent } from "./session-mutation-scope.ts";
import {
  patchSessionRows,
  type SessionActionHost,
  type SessionActionRow,
} from "./session-organizer-batch-mutations.ts";
import { patchSession } from "./session-organizer-patch.runtime.ts";

registerSessionMenuEnglish();
registerSessionOrganizationEnglish();

export async function snoozeSessionWithUndo(
  host: SessionActionHost,
  session: SessionActionRow,
  choice: { snoozedUntil: number; rememberCustom?: boolean },
  scope: SidebarSessionMutationScope,
) {
  const { snoozedUntil, rememberCustom } = choice;
  const result = await patchSession(host, session, { snoozedUntil }, scope, { sessionScope: true });
  if (result !== "completed" || !host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  if (rememberCustom) {
    rememberCustomSnooze(
      customSnoozeStorageKey(scope.client.gatewayUrl, scope.client.recoveryScope),
      snoozedUntil,
    );
  }
  const undoHost = sessionUndoHost(host, scope);
  showToast({
    message: t("sessionsView.sessionSnoozed", { time: formatSessionSnoozeWakeTime(snoozedUntil) }),
    actionLabel: t("common.undo"),
    onAction: () =>
      void patchSession(undoHost, session, { snoozedUntil: null }, scope, { sessionScope: true }),
  });
}

export async function promoteSession(
  host: SessionActionHost,
  session: SessionActionRow,
  scope: SidebarSessionMutationScope,
) {
  const result = await patchSession(host, session, { sidebarRoot: true }, scope, {
    sessionScope: true,
  });
  if (result === "completed" && host.sessionData.isSessionMutationScopeCurrent(scope)) {
    showToast({ message: t("sessionsView.sessionMovedToTopLevel") });
  }
}

/** Discover descendants only for hinted parents; leaf archives keep their existing fast path. */
export async function confirmSessionArchive(
  session: SessionActionRow,
  scope: SidebarSessionMutationScope,
  isCurrent: () => boolean,
): Promise<{ kind: "single" } | { kind: "tree"; rows: SessionActionRow[] } | null> {
  if (!isCurrent()) {
    return null;
  }
  if (session.hasArchiveDescendants && scope.gateway.snapshot.phase !== "connected") {
    // Complete subtree discovery requires live reads. Offline intent targets
    // only the selected row, with the same explicit nested-session warning.
    const options = {
      title: t("sessionsView.archiveSessionTitle"),
      message:
        t("sessionsView.archiveSessionNestedOffline", { session: session.label }) +
        (hasActiveArchiveWork(session) ? "\n\n" + t("sessionsView.archiveRunningSessions") : ""),
      confirmLabel: t("sessionsView.archiveThisSession"),
      signal: scope.signal,
    };
    const confirmed = await confirmWithBoundAutomations(
      archiveAutomationRequest([session], scope),
      (notice) => showConfirmDialog(notice ? withBoundAutomationNotice(options, notice) : options),
      Boolean,
    );
    return confirmed && isCurrent() ? { kind: "single" } : null;
  }
  if (session.hasArchiveDescendants) {
    const { session: root } = await scope.sessions.describe(
      {
        key: session.key,
        agentId: resolveUiSessionRowAgentId(session, scope.selectedAgentId),
      },
      { refresh: true },
    );
    if (!isCurrent()) {
      return null;
    }
    if (!root || !root.sessionId || root.sessionId !== session.sessionId || root.archived) {
      throw new Error(t("sessionsView.archiveTreeChanged"));
    }
    if (isSubagentSessionKey(root.key)) {
      throw new Error(t("sessionsView.archiveTreeRootRequired"));
    }
    // A tree action snapshots complete child windows, never just expanded sidebar rows.
    const rows: GatewaySessionRow[] = [];
    const ancestorsByKey = new Map<string, readonly GatewaySessionRow[]>();
    const visited = new Set<string>();
    const pending: Array<{ row: GatewaySessionRow; ancestors: readonly GatewaySessionRow[] }> = [
      { row: root, ancestors: [] },
    ];
    while (pending.length > 0) {
      const { row, ancestors } = pending.shift()!;
      if (visited.has(row.key)) {
        continue;
      }
      visited.add(row.key);
      const persistent = !isSubagentSessionKey(row.key);
      if (
        row.archived ||
        (persistent && row !== root && (row.sidebarRoot || row.category?.trim()))
      ) {
        continue;
      }
      if (persistent) {
        rows.push(row);
        ancestorsByKey.set(row.key, ancestors);
      }
      const children = await fetchChildSessionRows({
        sessions: scope.sessions,
        parentKey: row.key,
        isCurrent,
      });
      if (!isCurrent() || children === null) {
        return null;
      }
      const nextAncestors = persistent ? [row, ...ancestors] : ancestors;
      pending.push(...children.map((child) => ({ row: child, ancestors: nextAncestors })));
    }
    if (!isCurrent()) {
      return null;
    }
    if (rows.some((row) => !row.sessionId)) {
      throw new Error(t("sessionsView.archiveTreeChanged"));
    }
    if (rows.length > 1) {
      // Descendants settle before their ancestors, which must remain unarchived.
      const guardedRows: SessionActionRow[] = rows.toReversed().map((row) => ({
        key: row.key,
        agentId: row.agentId,
        sessionId: row.sessionId,
        sharingRole: row.sharingRole,
        label: resolveSessionDisplayName(row.key, row),
        pinned: row.pinned === true,
        archived: row.archived,
        category: row.category,
        active: row.key === session.key && session.active,
        archiveGuard: {
          expectedSidebarRoot: row.sidebarRoot === true,
          expectedCategory: row.category ?? null,
          expectedArchived: false,
          expectedSidebarAncestors: (ancestorsByKey.get(row.key) ?? []).map((ancestor) => {
            if (!ancestor.sessionId) {
              throw new Error(t("sessionsView.archiveTreeChanged"));
            }
            return {
              key: ancestor.key,
              agentId: resolveUiSessionRowAgentId(ancestor, scope.selectedAgentId),
              expectedSessionId: ancestor.sessionId,
              expectedSidebarRoot: ancestor.sidebarRoot === true,
              expectedCategory: ancestor.category ?? null,
            };
          }),
        },
      }));
      // Only direct children move to the top level; deeper sessions stay under them.
      const directChildCount = rows.filter(
        (row) => ancestorsByKey.get(row.key)?.length === 1,
      ).length;
      const options = {
        title: t("sessionsView.archiveSessionTitle"),
        message:
          t(
            directChildCount === 1
              ? "sessionsView.archiveSessionNestedOne"
              : "sessionsView.archiveSessionNestedOther",
            { count: String(directChildCount), session: session.label },
          ) +
          (rows.some(hasActiveArchiveWork)
            ? "\n\n" + t("sessionsView.archiveRunningSessions")
            : ""),
        confirmLabel: t("sessionsView.archiveAllSessions", { count: String(rows.length) }),
        alternativeLabel: t("sessionsView.archiveThisSession"),
        groupChoicesOnMobile: true,
        signal: scope.signal,
      };
      // The tree choice keeps its own labels; only bound conversations that end up archived pause.
      const automationTargets = rows.map((row) => ({
        key: row.key,
        agentId: resolveUiSessionRowAgentId(row, scope.selectedAgentId),
        label: resolveSessionDisplayName(row.key, row),
        hasAutomation: row.hasAutomation,
      }));
      const choice = await confirmWithBoundAutomations(
        archiveAutomationRequest(automationTargets, scope),
        (notice) =>
          showConfirmChoiceDialog(
            notice
              ? {
                  ...withBoundAutomationNotice(options, notice),
                  confirmLabel: options.confirmLabel,
                }
              : options,
          ),
        (result) => result !== null,
      );
      if (!isCurrent() || choice === null) {
        return null;
      }
      return choice === "confirm" ? { kind: "tree", rows: guardedRows } : { kind: "single" };
    }
  }
  return (await confirmRunningSessionsArchive([session], scope)) && isCurrent()
    ? { kind: "single" }
    : null;
}

type SessionArchiveActivity = Pick<
  SessionActionRow,
  "hasActiveRun" | "gatewayHasActiveRun" | "hasActiveSubagentRun"
>;

function hasActiveArchiveWork(session: SessionArchiveActivity): boolean {
  return Boolean(
    (session.gatewayHasActiveRun ?? session.hasActiveRun) || session.hasActiveSubagentRun,
  );
}

type SessionArchiveConfirmScope = Pick<
  SidebarSessionMutationScope,
  "gateway" | "selectedAgentId" | "signal"
>;

function archiveAutomationRequest(
  sessions: readonly Pick<SessionActionRow, "key" | "agentId" | "label" | "hasAutomation">[],
  scope: SessionArchiveConfirmScope,
) {
  return {
    action: "archive" as const,
    sessions,
    gateway: scope.gateway,
    selectedAgentId: scope.selectedAgentId,
    signal: scope.signal,
  };
}

export async function confirmRunningSessionsArchive(
  sessions: readonly (SessionArchiveActivity &
    Pick<SessionActionRow, "key" | "agentId" | "label" | "hasAutomation">)[],
  scope: SessionArchiveConfirmScope,
): Promise<boolean> {
  const running = sessions.some(hasActiveArchiveWork);
  const single = sessions.length === 1 ? sessions[0] : undefined;
  const options = {
    message: !running
      ? ""
      : single
        ? t("sessionsView.archiveRunningSessionConfirm", { session: single.label })
        : t("sessionsView.archiveRunningSessions"),
    confirmLabel: single
      ? t("sessionsView.archiveSession")
      : t("sessionsView.archiveSessionCount", { count: String(sessions.length) }),
    signal: scope.signal,
  };
  // Leaf and batch archives confirm only for active work or bound automations.
  return confirmWithBoundAutomations(
    archiveAutomationRequest(sessions, scope),
    (notice) =>
      notice
        ? showConfirmDialog(withBoundAutomationNotice(options, notice))
        : running
          ? showConfirmDialog(options)
          : Promise.resolve(true),
    Boolean,
  );
}

export async function archiveSessionWithUndo(
  host: SessionActionHost,
  session: SessionActionRow,
  scope: SidebarSessionMutationScope,
) {
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  let choice: Awaited<ReturnType<typeof confirmSessionArchive>>;
  try {
    choice = await confirmSessionArchive(session, scope, () =>
      host.sessionData.isSessionMutationScopeCurrent(scope),
    );
  } catch (error) {
    if (host.sessionData.isSessionMutationScopeCurrent(scope)) {
      host.sessionData.publishSessionMutationError(scope, error);
    }
    return;
  }
  if (!choice) {
    return;
  }
  if (choice.kind === "tree") {
    await archiveConfirmedSessionsWithUndo(host, choice.rows, scope);
    return;
  }
  const finishArchive = scope.sessions.beginArchive(session.key, session.sessionId);
  if (!finishArchive) {
    return;
  }
  const undoPins = captureSessionArchivePins(scope, [session.key]);
  let result: SidebarSessionMutationResult;
  try {
    result = await patchSession(
      {
        sessionData: host.sessionData,
        selectSession: (key) => host.selectSession(key),
        sidebarSessionStatusFilter: () => host.sidebarSessionStatusFilter(),
        pruneSidebarSessionEntry: (key) =>
          undoPins.prune(key, () => host.pruneSidebarSessionEntry(key)),
      },
      session,
      { archived: true },
      scope,
      { sessionScope: true },
    );
  } finally {
    finishArchive();
  }
  if (result !== "completed" || !host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  showToast({
    message: t("sessionsView.sessionArchived"),
    actionLabel: t("common.undo"),
    onAction: archiveUndoAction(host, [{ session, pinned: session.pinned }], scope, undoPins),
  });
}

export async function archiveSessionsWithUndo(
  host: SessionActionHost,
  rows: readonly SessionActionRow[],
  scope: SidebarSessionMutationScope,
) {
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  if (await confirmRunningSessionsArchive(rows, scope)) {
    await archiveConfirmedSessionsWithUndo(host, rows, scope);
  }
}

export async function archiveConfirmedSessionsWithUndo(
  host: SessionActionHost,
  rows: readonly SessionActionRow[],
  scope: SidebarSessionMutationScope,
): Promise<"completed" | "stale" | { status: "failed"; error: unknown } | void> {
  if (rows.length === 0 || !host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  // Once confirmed, finish the batch and publish its outcome across page navigation.
  // Online work stays connection-scoped; offline Undo follows its recovery owner.
  const outcomeHost = sessionUndoHost(host, scope);
  const pending = rows.flatMap((row) => {
    const finish = scope.sessions.beginArchive(row.key, row.sessionId);
    return finish ? [{ row, finish }] : [];
  });
  if (pending.length === 0) {
    return;
  }
  const pendingRows = pending.map(({ row }) => row);
  const undoPins = captureSessionArchivePins(
    scope,
    pendingRows.map((row) => row.key),
  );
  let failure: { status: "failed"; error: unknown } | undefined;
  const initialHost: SessionActionHost = {
    ...outcomeHost,
    pruneSidebarSessionEntry: (key) =>
      undoPins.prune(key, () => outcomeHost.pruneSidebarSessionEntry(key)),
    sessionData: {
      ...outcomeHost.sessionData,
      publishSessionMutationError: (candidate, error) => {
        failure = { status: "failed", error };
        outcomeHost.sessionData.publishSessionMutationError(candidate, error);
      },
    },
  };
  let archivedRows: SessionActionRow[] | null;
  try {
    archivedRows = await patchSessionRows(initialHost, pendingRows, { archived: true }, scope, {
      sessionScope: true,
    });
  } finally {
    for (const { finish } of pending) {
      finish();
    }
  }
  if (!archivedRows || archivedRows.length === 0) {
    return failure ?? "stale";
  }
  const archived = archivedRows.map((session) => ({ session, pinned: session.pinned }));
  showToast({
    message:
      archived.length === 1
        ? t("sessionsView.sessionArchived")
        : t("sessionsView.sessionsArchived", { count: String(archived.length) }),
    actionLabel: t("common.undo"),
    onAction: archiveUndoAction(outcomeHost, archived, scope, undoPins),
    // Keep a partial-failure notice readable before presenting successful-only Undo.
    fifo: true,
  });
  return failure ?? "completed";
}

function archiveUndoAction(
  host: SessionActionHost,
  archived: readonly { session: SessionActionRow; pinned: boolean }[],
  scope: SidebarSessionMutationScope,
  undoPins: ReturnType<typeof captureSessionArchivePins>,
): () => void {
  const undoHost = sessionUndoHost(host, scope);
  return () => {
    void undoPins
      .restore(() => restoreArchivedSessions(undoHost, archived, scope))
      .catch((error: unknown) => {
        undoHost.sessionData.publishSessionMutationError(scope, error);
      });
  };
}

/** The toast alone retains this receipt; ordinary Unarchive never restores personal pins. */
export function captureSessionArchivePins(
  scope: SidebarSessionMutationScope,
  keys: readonly string[],
) {
  const { navigation } = scope.context;
  const isCurrent = captureSessionUndoCurrent(scope);
  const pins = keys.filter((key) => navigation.snapshot.sidebarEntries.includes("session:" + key));
  let pruning: string | undefined;
  const restore = async (restoreSessions: () => Promise<readonly string[]>): Promise<void> => {
    if (!isCurrent()) {
      return;
    }
    const changed = new Set<string>();
    let previous = new Set(navigation.snapshot.sidebarEntries);
    // A manual pin/unpin during the request is newer intent, even if its final value matches.
    const stop = navigation.subscribe(({ sidebarEntries }) => {
      for (const key of pins) {
        const entry = "session:" + key;
        if (key !== pruning && sidebarEntries.includes(entry) !== previous.has(entry)) {
          changed.add(key);
        }
      }
      previous = new Set(sidebarEntries);
    });
    try {
      const restored = await restoreSessions();
      if (!isCurrent()) {
        return;
      }
      const entries = navigation.snapshot.sidebarEntries;
      const additions = pins.filter(
        (key) => restored.includes(key) && !changed.has(key) && !entries.includes("session:" + key),
      );
      if (additions.length > 0) {
        navigation.update({
          sidebarEntries: [...entries, ...additions.map((key) => "session:" + key)],
        });
      }
    } finally {
      stop();
    }
  };
  return {
    restore,
    prune(key: string, action: () => void) {
      // An archive ACK can arrive after Undo was queued; it is not a manual unpin.
      pruning = key;
      try {
        action();
      } finally {
        pruning = undefined;
      }
    },
  };
}

function captureSessionUndoCurrent(scope: SidebarSessionMutationScope): () => boolean {
  const connection = scope.sessions.captureConnectionScope();
  if (connection) {
    return () => scope.sessions.isConnectionScopeCurrent(connection);
  }
  // Offline Undo follows the admitted recovery owner across reconnect, not the pane's
  // retired confirmation epoch. The session owner still authorizes each restore.
  const owner = gatewayPresentationScope(scope.gateway).key;
  return () =>
    scope.allowDeferred === true &&
    isSessionMutationScopeCurrent(scope.context, scope) &&
    gatewayPresentationScope(scope.gateway).key === owner;
}

function sessionUndoHost(
  host: SessionActionHost,
  scope: SidebarSessionMutationScope,
): SessionActionHost {
  // The toast outlives its originating pane; captured row IDs still fence
  // replacement conversations during restore.
  const isCurrent = captureSessionUndoCurrent(scope);
  return {
    pruneSidebarSessionEntry: (key) => host.pruneSidebarSessionEntry(key),
    selectSession: (key) => host.selectSession(key),
    sidebarSessionStatusFilter: () => host.sidebarSessionStatusFilter(),
    sessionData: {
      refreshSidebarSessions: (agentId) => host.sessionData.refreshSidebarSessions(agentId),
      isSessionMutationScopeCurrent: isCurrent,
      publishSessionMutationError: (candidate, error) => {
        if (host.sessionData.isSessionMutationScopeCurrent(candidate)) {
          host.sessionData.publishSessionMutationError(candidate, error);
        } else if (isCurrent()) {
          showToast({ message: formatUiError(error) });
        }
      },
    },
  };
}

// Undo restores captured rows; the roster owner refreshes whichever queries are now visible.
async function restoreArchivedSessions(
  host: SessionActionHost,
  archived: readonly { session: SessionActionRow; pinned: boolean }[],
  scope: SidebarSessionMutationScope,
): Promise<readonly string[]> {
  let restoredKeys: string[];
  const snapshot = scope.gateway.snapshot;
  const deferred =
    snapshot.phase !== "connected" ||
    Boolean(snapshot.deferredIntentCount || snapshot.deferredIntentDraining);
  const rows = archived.map((entry) => entry.session);
  if (deferred) {
    const restored = await Promise.all(
      rows.map(async (session) => {
        const receipt = Promise.withResolvers<boolean>();
        const result = await patchSession(host, session, { archived: false }, scope, {
          deferListRefresh: true,
          sessionScope: true,
          onConfirmed: (confirmed) =>
            receipt.resolve(confirmed.entry.sessionId === session.sessionId),
          onDeferredSettled: () => receipt.resolve(false),
        });
        return result === "completed" && (await receipt.promise) ? session.key : null;
      }),
    );
    return restored.filter((key) => key !== null);
  }
  if (archived.length === 1) {
    const { session, pinned } = archived[0]!;
    const restored = await patchSession(
      host,
      session,
      {
        archived: false,
        ...(pinned ? { pinned: true } : {}),
      },
      scope,
      { deferListRefresh: true, sessionScope: true },
    );
    if (restored !== "completed") {
      return [];
    }
    restoredKeys = [session.key];
  } else {
    const restored = await patchSessionRows(host, rows, { archived: false }, scope, {
      deferListRefresh: true,
      sessionScope: true,
    });
    if (!restored) {
      return [];
    }
    restoredKeys = restored.map((session) => session.key);
    const repinRows = archived.flatMap(({ session, pinned }) =>
      pinned && restored.includes(session) ? [session] : [],
    );
    if (repinRows.length > 0) {
      const repinned = await patchSessionRows(host, repinRows, { pinned: true }, scope, {
        deferListRefresh: true,
        sessionScope: true,
      });
      if (!repinned && !host.sessionData.isSessionMutationScopeCurrent(scope)) {
        return [];
      }
    }
  }
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return [];
  }
  scope.sessions.invalidate();
  try {
    const result = await scope.sessions.refreshReplacement();
    if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
      return [];
    }
    if (!result && scope.sessions.state.error) {
      host.sessionData.publishSessionMutationError(scope, scope.sessions.state.error);
    }
  } catch (error) {
    if (host.sessionData.isSessionMutationScopeCurrent(scope)) {
      host.sessionData.publishSessionMutationError(scope, error);
    }
  }
  return restoredKeys;
}
