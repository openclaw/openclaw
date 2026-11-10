import { createMemo, onSettled, Show } from "solid-js";
import { projectGateway } from "../lib/reactive/application.ts";
import { readSessionMethodAccess } from "../lib/session-method-access.ts";
import { resolveSessionRenamePatch } from "../lib/session-rename.ts";
import type { SessionListHost } from "./app-sidebar-session-render-types.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { SessionRenameInput } from "./solid/session-rename-input.tsx";

export function SidebarSessionRename(props: {
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
  let value = target.renameValue;
  let settled = false;
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
  function commit() {
    if (settled) {
      return;
    }
    const snapshot = context?.gateway.snapshot;
    if (!snapshot || (snapshot.phase !== "connected" && !snapshot.hello)) {
      return;
    }
    const patch = resolveSessionRenamePatch(value, target.renameValue, target.userLabel);
    // Enter removes the input and emits blur; only the first settlement may write.
    close();
    if (
      patch &&
      context === props.host.sessionDataContext &&
      sessions === context.sessions &&
      snapshot.client === client
    ) {
      void props.host.sessionOrganizer.patchSession(target, patch, { sessionScope: true });
    }
  }
  return (
    <Show
      when={access().allowed && gateway?.read().snapshot.client === client}
      fallback={<RetiredRename onClose={close} />}
    >
      <SessionRenameInput
        class="sidebar-recent-session__rename-input"
        renameValue={value}
        renameDisabledReason={(() => {
          const current = access();
          return current.allowed ? undefined : current.reason;
        })()}
        onRenameInput={(next) => {
          value = next;
        }}
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
