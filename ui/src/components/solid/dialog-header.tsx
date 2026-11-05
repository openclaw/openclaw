import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import { Icon } from "./icon.tsx";

/** The shared top of an `.oc-dialog`: title, close and a muted description. */
export function DialogHeader(props: {
  title: JSX.Element;
  description?: JSX.Element;
  closeDisabled?: boolean;
  /** Left out when the dialog must not be dismissed, such as an unacknowledged secret. */
  onClose?: () => void;
}) {
  return (
    <div class="oc-dialog__header">
      <h2 class="oc-dialog__title">{props.title}</h2>
      <Show when={props.onClose}>
        <button
          type="button"
          class="oc-dialog__close"
          aria-label={t("common.close")}
          disabled={props.closeDisabled}
          onClick={() => props.onClose?.()}
        >
          <Icon name="x" />
        </button>
      </Show>
      <Show when={props.description}>
        <div class="oc-dialog__description">{props.description}</div>
      </Show>
    </div>
  );
}
