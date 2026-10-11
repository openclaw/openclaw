import type WaPopover from "@awesome.me/webawesome/dist/components/popover/popover.js";
import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import type { SessionBranch } from "../../../api/types.ts";
import { icons } from "../../../components/icons.ts";
import { syncPopoverExpanded, syncPopoverLabel } from "../../../components/web-awesome-popover.ts";
import { t } from "../../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../../lib/format.ts";

type ChatPaneVersionsMenuProps = {
  catalog: boolean;
  paneId: string;
  branches: SessionBranch[];
  branchSwitchDisabledReason: string | null;
  onBranchSelect: (leafEntryId: string) => void;
};

export function renderChatPaneVersionsMenu(props: ChatPaneVersionsMenuProps) {
  return !props.catalog && props.branches.length > 1
    ? html`
        <wa-dropdown
          class="chat-pane__branches-menu"
          placement="bottom-end"
          @wa-hide=${(event: Event) => {
            const menu = event.currentTarget;
            if (event.target === menu && menu instanceof HTMLElement) {
              const help = menu.querySelector<WaPopover>(".chat-pane__versions-help");
              if (help) {
                help.open = false;
              }
            }
          }}
          @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
            const leafEntryId = event.detail.item.value;
            const branch = props.branches.find(
              (candidate) => candidate.leafEntryId === leafEntryId,
            );
            if (leafEntryId && branch && !branch.active && !props.branchSwitchDisabledReason) {
              props.onBranchSelect(leafEntryId);
            }
          }}
        >
          <button
            slot="trigger"
            class="btn btn--ghost btn--icon chat-icon-btn chat-pane__branches-trigger"
            type="button"
            ?disabled=${Boolean(props.branchSwitchDisabledReason)}
            title=${props.branchSwitchDisabledReason ?? t("chat.sessionHeader.branches")}
            aria-label=${t("chat.sessionHeader.branches")}
          >
            ${icons.history}
          </button>
          <div class="chat-pane__versions-heading">
            <span>${t("chat.sessionHeader.branches")}</span>
            <button
              id=${`versions-help-${props.paneId}`}
              class="btn btn--ghost btn--icon chat-pane__versions-info"
              type="button"
              autofocus
              aria-label=${t("chat.sessionHeader.versionsHelpLabel")}
              aria-haspopup="dialog"
              aria-expanded="false"
              aria-controls=${`versions-help-content-${props.paneId}`}
            >
              ${icons.info}
            </button>
            <wa-popover
              ${ref(syncPopoverLabel)}
              id=${`versions-help-content-${props.paneId}`}
              class="chat-pane__versions-help"
              for=${`versions-help-${props.paneId}`}
              aria-label=${t("chat.sessionHeader.versionsHelpLabel")}
              placement="bottom-end"
              @wa-show=${syncPopoverExpanded}
              @wa-hide=${syncPopoverExpanded}
            >
              ${t("chat.sessionHeader.versionsHelp")}
            </wa-popover>
          </div>
          ${props.branches.map((branch) => {
            const updatedAt = Date.parse(branch.updatedAt ?? "");
            const relativeTime = formatRelativeTimestamp(updatedAt, { fallback: "" });
            return html`
              <wa-dropdown-item
                class="chat-pane__branch-item"
                value=${branch.leafEntryId}
                ?disabled=${branch.active || Boolean(props.branchSwitchDisabledReason)}
                data-active=${branch.active ? "true" : "false"}
              >
                <span class="chat-pane__branch-copy">
                  <span class="chat-pane__branch-headline"
                    >${branch.headline || t("chat.sessionHeader.untitledBranch")}</span
                  >
                  <span class="chat-pane__branch-meta"
                    >${t(
                      branch.messageCount === 1
                        ? "chat.sessionHeader.oneMessage"
                        : "chat.sessionHeader.messages",
                      { count: String(branch.messageCount) },
                    )}${relativeTime ? ` · ${relativeTime}` : ""}</span
                  >
                </span>
                ${
                  branch.active
                    ? html`<span
                        slot="details"
                        class="chat-pane__branch-active"
                        aria-label=${t("chat.sessionHeader.activeBranch")}
                        >${icons.check}</span
                      >`
                    : nothing
                }
              </wa-dropdown-item>
            `;
          })}
        </wa-dropdown>
      `
    : nothing;
}
