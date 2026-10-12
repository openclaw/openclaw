import type WaPopover from "@awesome.me/webawesome/dist/components/popover/popover.js";
import { For, Show } from "solid-js";
import type { SessionBranch } from "../../../api/types.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { syncPopoverExpanded, syncPopoverLabel } from "../../../components/web-awesome-popover.ts";
import { formatRelativeTimestamp } from "../../../lib/format.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lit/solid-bridge.ts";

type ChatPaneVersionsMenuProps = {
  catalog: boolean;
  branches: SessionBranch[];
  branchSwitchDisabledReason: string | null;
  onBranchSelect: (leafEntryId: string) => void;
};

type Props = { menu: ChatPaneVersionsMenuProps };
let nextId = 0;

function ChatPaneVersionsMenuContent(props: Props) {
  const helpId = `versions-help-${++nextId}`;
  return (
    <Show when={!props.menu.catalog && props.menu.branches.length > 1}>
      <wa-dropdown
        class="chat-pane__branches-menu"
        placement="bottom-end"
        onWa-hide={(event: Event) => {
          const menu = event.currentTarget;
          if (event.target === menu && menu instanceof HTMLElement) {
            const help = menu.querySelector<WaPopover>(".chat-pane__versions-help");
            if (help) {
              help.open = false;
            }
          }
        }}
        onWa-select={(event: CustomEvent<{ item: { value?: string } }>) => {
          const leafEntryId = event.detail.item.value;
          const branch = props.menu.branches.find(
            (candidate) => candidate.leafEntryId === leafEntryId,
          );
          if (leafEntryId && branch && !branch.active && !props.menu.branchSwitchDisabledReason) {
            props.menu.onBranchSelect(leafEntryId);
          }
        }}
      >
        <button
          slot="trigger"
          class="btn btn--ghost btn--icon chat-icon-btn chat-pane__branches-trigger"
          type="button"
          disabled={Boolean(props.menu.branchSwitchDisabledReason)}
          title={props.menu.branchSwitchDisabledReason ?? t("chat.sessionHeader.branches")}
          aria-label={t("chat.sessionHeader.branches")}
        >
          <Icon name="history" />
        </button>
        <div class="chat-pane__versions-heading">
          <span>{t("chat.sessionHeader.branches")}</span>
          <button
            id={helpId}
            class="btn btn--ghost btn--icon chat-pane__versions-info"
            type="button"
            autofocus
            aria-label={t("chat.sessionHeader.versionsHelpLabel")}
            aria-haspopup="dialog"
            aria-expanded="false"
            aria-controls={`${helpId}-content`}
          >
            <Icon name="info" />
          </button>
          <wa-popover
            ref={syncPopoverLabel}
            id={`${helpId}-content`}
            class="chat-pane__versions-help"
            for={helpId}
            aria-label={t("chat.sessionHeader.versionsHelpLabel")}
            placement="bottom-end"
            onWa-show={syncPopoverExpanded}
            onWa-hide={syncPopoverExpanded}
          >
            {t("chat.sessionHeader.versionsHelp")}
          </wa-popover>
        </div>
        <For each={props.menu.branches} keyed={(branch) => branch.leafEntryId}>
          {(branch) => {
            const relativeTime = () =>
              formatRelativeTimestamp(Date.parse(branch().updatedAt ?? ""), { fallback: "" });
            return (
              <wa-dropdown-item
                class="chat-pane__branch-item"
                value={branch().leafEntryId}
                prop:disabled={branch().active || Boolean(props.menu.branchSwitchDisabledReason)}
                data-active={branch().active ? "true" : "false"}
              >
                <span class="chat-pane__branch-copy">
                  <span class="chat-pane__branch-headline">
                    {branch().headline || t("chat.sessionHeader.untitledBranch")}
                  </span>
                  <span class="chat-pane__branch-meta">
                    {t(
                      branch().messageCount === 1
                        ? "chat.sessionHeader.oneMessage"
                        : "chat.sessionHeader.messages",
                      { count: String(branch().messageCount) },
                    )}
                    {relativeTime() ? ` · ${relativeTime()}` : ""}
                  </span>
                </span>
                <Show when={branch().active}>
                  <span
                    slot="details"
                    class="chat-pane__branch-active"
                    aria-label={t("chat.sessionHeader.activeBranch")}
                  >
                    <Icon name="check" />
                  </span>
                </Show>
              </wa-dropdown-item>
            );
          }}
        </For>
      </wa-dropdown>
    </Show>
  );
}

type ChatPaneVersionsMenu = SolidBridgeElement<Props>;
defineSolidBridge<Props>("openclaw-chat-pane-versions-menu", ChatPaneVersionsMenuContent, {
  properties: {
    menu: {
      default: {
        catalog: true,
        branches: [],
        branchSwitchDisabledReason: null,
        onBranchSelect: () => {},
      },
      attribute: false,
    },
  },
});

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-pane-versions-menu": ChatPaneVersionsMenu;
  }
}
