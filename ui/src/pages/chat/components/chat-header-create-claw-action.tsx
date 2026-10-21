import { Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import "../../../components/tooltip.ts";
import { t } from "../../../lib/reactive/i18n.ts";

export function ChatHeaderCreateClawAction(props: { onCreateClaw?: () => void }) {
  return (
    <Show when={props.onCreateClaw}>
      <openclaw-tooltip prop:content={`${t("clawsDraft.title")} · ${t("clawsDraft.railHint")}`}>
        <button
          class="btn btn--ghost btn--icon chat-icon-btn"
          type="button"
          aria-label={t("clawsDraft.title")}
          onClick={() => props.onCreateClaw?.()}
        >
          <Icon name="share" />
        </button>
      </openclaw-tooltip>
    </Show>
  );
}
