import { action, createMemo, createOptimistic, createSignal, Errored, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { registerChatWorktreeEnglish } from "../../../i18n/locales/en-chat-worktree.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ChatComposerProps } from "./chat-composer-types.ts";

registerChatComposerEnglish();
registerChatWorktreeEnglish();

/** The session projection owns readiness; this component presents only the explicit action. */
export function ChatWorktreeRestoreNotice(
  props: Pick<ChatComposerProps, "selectedSession" | "contextGateway" | "connected">,
) {
  const [saving, setSaving] = createOptimistic(false);
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
    yield client.request("worktrees.restore", { id }, { timeoutMs: 310_000 });
  });
  return (
    <div class="agent-chat__workspace-removed callout warn callout--action" role="status">
      <span class="agent-chat__disabled-banner-icon">
        <Icon name="alertTriangle" />
      </span>
      <div class="callout__content">
        <div>{t("chat.composer.workspaceRemoved")}</div>
        <div>
          {t(
            props.selectedSession?.worktreeState === "removed-fresh"
              ? "chat.composer.workspaceRestoreFreshDetail"
              : "chat.composer.workspaceRestoreSnapshotDetail",
          )}
        </div>
        <Show when={!saving()}>
          <Errored
            fallback={(error) => (
              <div role="alert">
                {formatUiError(error())} {t("chat.composer.workspaceRestoreHelp")}
              </div>
            )}
          >
            {outcome()}
          </Errored>
        </Show>
      </div>
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
    </div>
  );
}
