import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { collectKnownSessionGroups } from "../../lib/sessions/grouping.ts";
import type { SessionPatch } from "../../lib/sessions/patch.ts";
import { isPinnableUiSessionRow, isSubagentSessionKey } from "../../lib/sessions/session-key.ts";
import type { SessionsPageMutationResult } from "./mutation-runner.ts";
import type { createSessionsDialog } from "./page-dialog.ts";
import type { SessionsPageRequestScope } from "./request-scope.ts";
import type { SessionsPageState } from "./sessions-page-state.types.ts";

/** Group writes and assignments share one captured page scope; the roster stays with the page. */
export function createSessionGroups(host: {
  state: Pick<SessionsPageState, "result" | "error">;
  customGroups: () => readonly string[];
  captureScope: () => SessionsPageRequestScope | null;
  isCurrent: (scope: SessionsPageRequestScope) => boolean;
  accessError: (scope: SessionsPageRequestScope) => string | null;
  patch: (
    key: string,
    patch: SessionPatch,
    scope: SessionsPageRequestScope,
    expectedSessionId?: string,
  ) => Promise<SessionsPageMutationResult>;
  dialog: Pick<ReturnType<typeof createSessionsDialog>, "open">;
}) {
  const { state } = host;
  const known = () => [
    ...new Set(collectKnownSessionGroups(host.customGroups(), state.result?.sessions ?? [])),
  ];

  async function remember(
    name: string,
    scope = host.captureScope(),
  ): Promise<SessionsPageMutationResult> {
    if (!scope) {
      return "stale";
    }
    const accessError = host.accessError(scope);
    if (accessError) {
      return { status: "failed", error: accessError };
    }
    state.error = null;
    if (known().includes(name)) {
      return "completed";
    }
    try {
      const written = await scope.sessions.groupsPut([
        ...(scope.sessions.state.groups ?? []),
        name,
      ]);
      // Both the catalog and page must still own this write before a row can move.
      return written === "completed" && host.isCurrent(scope) ? "completed" : "stale";
    } catch (error) {
      if (!host.isCurrent(scope)) {
        return "stale";
      }
      state.error = error;
      return { status: "failed", error };
    }
  }

  function assignmentPatch(session: GatewaySessionRow, category: string | null): SessionPatch {
    return {
      category,
      ...(!isSubagentSessionKey(session.key) && !isPinnableUiSessionRow(session)
        ? { sidebarRoot: true }
        : {}),
    };
  }

  async function assign(key: string, category: string | null) {
    // A dropped key must already belong to the roster; patch can otherwise create a store entry.
    const session = state.result?.sessions.find((row) => row.key === key);
    if (!session) {
      return undefined;
    }
    const patch = assignmentPatch(session, category);
    if ((session.category?.trim() || null) === category && !patch.sidebarRoot) {
      return undefined;
    }
    const scope = host.captureScope();
    if (!scope) {
      return undefined;
    }
    if (category) {
      const remembered = await remember(category, scope);
      if (remembered !== "completed") {
        return remembered;
      }
    }
    return host.patch(key, patch, scope, session.sessionId);
  }

  async function create(sessionKey?: string) {
    // Capture the durable row before loading the dialog, not when its submit callback runs.
    const session = state.result?.sessions.find((row) => row.key === sessionKey);
    if (sessionKey && !session?.sessionId) {
      state.error = t("common.refresh");
      return;
    }
    await host.dialog.open(() => ({
      title: t("sessionsView.newGroupTitle"),
      label: t("sessionsView.newGroupPrompt"),
      submitLabel: t("sessionsView.newGroupCreate"),
      requireValue: true,
      submit: (name) => write(name, session),
    }));
  }

  async function write(name: string, session?: GatewaySessionRow): Promise<string | null> {
    state.error = null;
    const scope = host.captureScope();
    if (!scope) {
      return t("sessionsView.newGroupFailed");
    }
    const remembered = await remember(name, scope);
    if (remembered !== "completed") {
      return typeof remembered === "object"
        ? formatUiError(remembered.error)
        : t("sessionsView.newGroupStale");
    }
    if (!session) {
      return null;
    }
    const assigned = await host.patch(
      session.key,
      assignmentPatch(session, name),
      scope,
      session.sessionId,
    );
    return typeof assigned === "object"
      ? formatUiError(assigned.error)
      : assigned === "stale"
        ? t("sessionsView.newGroupStale")
        : null;
  }

  return { known, remember, assign, create };
}
