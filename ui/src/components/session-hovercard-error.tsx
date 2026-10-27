import { Show } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import type { SidebarSessionAttention } from "./app-sidebar-session-types.ts";
import { createHovercardControlRef } from "./portaled-hovercard-focus.ts";
import { sessionAttentionSubtitle } from "./session-attention-presentation.ts";
import { Icon } from "./solid/icon.tsx";

/** The row's own or folded child failure; Dismiss marks the failed session read. */
export function SessionHovercardError(props: {
  attention?: SidebarSessionAttention;
  dismiss?: () => void;
}) {
  return (
    <Show when={props.attention?.kind === "error" ? props.attention : undefined}>
      {(attention) => (
        <section class="session-hovercard__section session-hovercard__error">
          <span class="session-hovercard__error-icon" aria-hidden="true">
            <Icon name="alertTriangle" />
          </span>
          <span>{sessionAttentionSubtitle(attention(), t)}</span>
          <Show when={props.dismiss}>
            {(dismiss) => (
              <button
                ref={createHovercardControlRef()}
                class="session-hovercard__dismiss"
                type="button"
                onClick={() => dismiss()()}
              >
                {t("common.dismiss")}
              </button>
            )}
          </Show>
        </section>
      )}
    </Show>
  );
}
