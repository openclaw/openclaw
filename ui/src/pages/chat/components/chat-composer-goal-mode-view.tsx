import { Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import type { GoalComposer } from "./chat-composer-goal-mode.tsx";

export function GoalComposerMode(props: { composer: GoalComposer }) {
  return (
    <Show when={props.composer.mode}>
      {(mode) => (
        <div
          class="agent-chat__goal-mode composer-context-strip"
          role="group"
          aria-label={t("chat.goals.composerMode")}
        >
          <span class="agent-chat__goal-mode-label composer-context-strip__label">
            <span class="composer-context-strip__icon">{<Icon name="flag" />}</span>
            <span class="composer-context-strip__label-text">
              {t(mode().action === "edit" ? "chat.goals.edit" : "chat.goals.composerMode")}
            </span>
          </span>
          <span class="agent-chat__goal-mode-hint composer-context-strip__text">
            {t(mode().action === "edit" ? "chat.goals.editHint" : "chat.goals.startHint")}
          </span>
          <button
            type="button"
            class="composer-context-strip__dismiss"
            aria-label={t("chat.goals.cancel")}
            disabled={props.composer.pending}
            onClick={() => props.composer.cancel()}
          >
            {<Icon name="x" />}
          </button>
        </div>
      )}
    </Show>
  );
}
