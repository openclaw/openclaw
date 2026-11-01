import { createMemo } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { registerChatSessionEnglish } from "../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import type { SidebarPanelDefinitionParams } from "./chat-pane-embedded-types.ts";

registerEnglishCatalog(registerChatSessionEnglish);

type CompanionClearProps = Pick<
  SidebarPanelDefinitionParams,
  "connected" | "companion" | "onClearCompanion"
>;

export function ExternalPanelLink(props: {
  href: string;
  label: string;
  actionRef?: (element: HTMLAnchorElement) => void;
}) {
  return (
    <a
      ref={props.actionRef}
      class="rail-header__action"
      href={props.href}
      target="_blank"
      rel="noopener"
      aria-label={props.label}
      title={props.label}
    >
      <Icon name="externalLink" />
    </a>
  );
}

/** Snapshot mutable native state so menu diffing can compare the previous action. */
export function companionClearAction(input: CompanionClearProps) {
  return {
    id: "clear-side-chat",
    label: t("chat.rail.clear"),
    icon: "trash" as const,
    disabled: !input.connected || input.companion.turns.some((turn) => turn.status === "pending"),
    onActivate: () => {
      void input.onClearCompanion();
    },
  };
}

export function ClearCompanion(
  props: CompanionClearProps & { actionRef?: (element: HTMLButtonElement) => void },
) {
  const action = createMemo(() => companionClearAction(props));
  return (
    <openclaw-tooltip prop:content={action().label}>
      <button
        ref={props.actionRef}
        class="rail-header__action chat-session-rail__clear"
        type="button"
        aria-label={action().label}
        disabled={action().disabled}
        onClick={() => action().onActivate()}
      >
        <Icon name="trash" />
      </button>
    </openclaw-tooltip>
  );
}
