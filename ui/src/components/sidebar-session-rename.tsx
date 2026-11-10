import { createMemo, createSignal, onSettled, Show } from "solid-js";
import { formatUiError } from "../lib/format-error.ts";
import { projectGateway } from "../lib/reactive/application.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import { resolveSessionRenamePatch } from "../lib/session-rename.ts";
import { showToast } from "../lib/toast.ts";
import { SessionRenameInput } from "../pages/chat/components/chat-pane-header-identity.tsx";
import type { SessionListHost } from "./app-sidebar-session-render-types.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

export default function SidebarSessionRename(props: {
  host: SessionListHost;
  session: SidebarRecentSession;
  currentSession: SidebarRecentSession;
  onClose(): void;
}) {
  // Presentation is bound to the instance captured by the double-click, not a later row.
  const target = props.session;
  const context = props.host.sessionDataContext;
  const sessions = context?.sessions;
  const gateway = context && projectGateway(context.gateway);
  const client = context?.gateway.snapshot.client;
  const [value, setValue] = createSignal(target.renameValue);
  let settled = false;
  let pending = false;
  const [saving, setSaving] = createSignal(false);
  onSettled(() => () => {
    settled = true;
  });
  const access = createMemo(() =>
    readSessionMethodAccess(gateway?.read().snapshot ?? null, {
      method: "sessions.patch",
      params: { key: target.key, label: null },
      sessionScope: true,
      session: props.currentSession,
      allowDeferred: true,
    }),
  );
  function close() {
    settled = true;
    props.onClose();
  }
  async function commit() {
    if (settled || pending) {
      return;
    }
    const snapshot = context?.gateway.snapshot;
    if (!snapshot || (snapshot.phase !== "connected" && !snapshot.hello)) {
      return;
    }
    const patch = resolveSessionRenamePatch(value(), target.renameValue, target.userLabel);
    if (
      !patch ||
      context !== props.host.sessionDataContext ||
      sessions !== context.sessions ||
      snapshot.client !== client
    ) {
      close();
      return;
    }
    // Enter and its ensuing blur share one in-flight submission. The same input
    // retains the rejected draft; expected errors remain owned by the organizer.
    pending = true;
    setSaving(true);
    try {
      const result = await props.host.sessionOrganizer.patchSession(target, patch, {
        sessionScope: true,
      });
      if (!settled && result !== "failed") {
        close();
      }
    } catch (error) {
      if (!settled) {
        showToast({ severity: "error", message: formatUiError(error) });
      }
    } finally {
      pending = false;
      if (!settled) {
        setSaving(false);
      }
    }
  }

  return (
    <Show
      when={access().allowed && gateway?.read().snapshot.client === client}
      fallback={<RetiredRename onClose={close} />}
    >
      <SessionRenameInput
        class="sidebar-recent-session__rename-input"
        renameValue={value()}
        renameBusy={saving()}
        renameDisabledReason={(() => {
          const current = access();
          return current.allowed ? undefined : current.reason;
        })()}
        onRenameInput={(next) => setValue(next)}
        onCommitRename={commit}
        onCancelRename={close}
      />
    </Show>
  );
}

function RetiredRename(props: { onClose(): void }) {
  onSettled(() => props.onClose());
  return null;
}
