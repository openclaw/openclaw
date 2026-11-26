import { action, createMemo, createOptimistic, createSignal, Errored, Show } from "solid-js";
import { hasOperatorAdminAccess } from "../../../app/operator-access.ts";
import { registerChatWorktreeEnglish } from "../../../i18n/locales/en-chat-worktree.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ChatComposerProps } from "./chat-composer-types.ts";

registerChatWorktreeEnglish();

/** The session projection owns readiness; this component presents only the explicit action. */
export function ChatWorktreeRestoreNotice(
  props: Pick<ChatComposerProps, "selectedSession" | "contextGateway" | "connected"> & {
    onRestore: () => void;
  },
) {
  const [saving, setSaving] = createOptimistic(false);
  // The Gateway restores for an administrator or the conversation's creator only.
  const canRestore = createMemo(
    () =>
      props.selectedSession?.sharingRole === "owner" ||
      hasOperatorAdminAccess(props.contextGateway?.snapshot.hello?.auth ?? null),
  );
  const [attempt, setAttempt] = createSignal<{ result: Promise<void> }>();
  const outcome = createMemo(() => attempt()?.result.then(() => null), { loadingValue: undefined });
  const restore = action(function* () {
    const gateway = props.contextGateway;
    const client = gateway?.snapshot.phase === "connected" ? gateway.snapshot.client : null;
    const id = props.selectedSession?.worktree?.id;
    if (!client || !id || saving()) {
      return;
    }
    setSaving(true);
    props.onRestore();
    yield client.request("worktrees.restore", { id }, { timeoutMs: 310_000 });
  });
  return (
    <div
      class="agent-chat__workspace-removed agent-chat__disabled-banner agent-chat__disabled-banner--replacement callout callout--action"
      role="status"
    >
      <div class="callout__content">
        <div>
          {t(
            !canRestore()
              ? "chat.composer.workspaceRestoreAskAdmin"
              : props.selectedSession?.worktreeState === "removed-fresh"
                ? "chat.composer.workspaceRestoreFreshDetail"
                : "chat.composer.workspaceRestoreSnapshotDetail",
          )}
        </div>
        <Show when={!saving()}>
          <Errored
            fallback={(error) => (
              <div class="agent-chat__workspace-restore-error" role="alert">
                {formatUiError(error())} {t("chat.composer.workspaceRestoreHelp")}
              </div>
            )}
          >
            {outcome()}
          </Errored>
        </Show>
      </div>
      <Show when={canRestore()}>
        <button
          type="button"
          class="btn btn--sm"
          disabled={!props.connected || saving()}
          aria-busy={saving() ? "true" : "false"}
          onClick={() => {
            const result = restore();
            setAttempt({ result });
            void result.catch(() => {});
          }}
        >
          <Show when={saving()}>
            <span class="btn__spinner" aria-hidden="true" />
          </Show>
          {saving()
            ? t("chat.composer.workspaceRestoring")
            : t(
                props.selectedSession?.worktreeState === "removed-fresh"
                  ? "chat.composer.workspaceRestoreFresh"
                  : "chat.composer.workspaceRestore",
              )}
        </button>
      </Show>
    </div>
  );
}
