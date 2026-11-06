import { Show, action, createOptimistic } from "solid-js";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { CompactionStatus } from "../tool-stream-contract.ts";

registerEnglishCatalog(registerChatComposerEnglish);

export type ContextCompactProps = {
  /** Absent when this viewer cannot compact the session; the control is hidden. */
  onCompact?: () => void | Promise<unknown>;
  /** Pane-owned lifecycle, so compactions started elsewhere also read as busy here. */
  compactionStatus?: CompactionStatus | null;
  runActive?: boolean;
  connected: boolean;
  /** Surface-owned reasons to hold the control, such as an unloaded report. */
  busy?: boolean;
  /** Usage crossed the warning threshold, so compaction is the suggested action. */
  warning?: boolean;
};

/**
 * The one Compact control shared by the composer popover and the context panel. It
 * owns its request's busy state; the pane's compaction status covers the rest.
 */
export function ContextCompactButton(props: ContextCompactProps) {
  const [requesting, setRequesting] = createOptimistic(false);
  const compacting = () =>
    requesting() ||
    props.compactionStatus?.phase === "active" ||
    props.compactionStatus?.phase === "retrying";
  const disabled = () => !props.connected || props.busy || props.runActive || compacting();
  const compact = action(function* () {
    if (disabled()) {
      return;
    }
    setRequesting(true);
    yield props.onCompact?.();
  });
  return (
    <Show when={props.onCompact}>
      <button
        type="button"
        class={["chat-context__compact", { "chat-context__compact--high": props.warning }]}
        disabled={disabled()}
        aria-busy={compacting() ? "true" : undefined}
        title={t(
          props.runActive && !compacting()
            ? "chat.composer.contextUsage.compactAfterRun"
            : "chat.composer.contextUsage.compactDescription",
        )}
        onClick={() => void compact()}
      >
        <Show when={compacting()}>
          <span class="btn__spinner" aria-hidden="true" />
        </Show>
        {t(
          compacting()
            ? "chat.composer.contextUsage.compacting"
            : "chat.composer.contextUsage.compact",
        )}
      </button>
    </Show>
  );
}
