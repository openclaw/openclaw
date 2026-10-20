import { createMemo, createSignal, Show } from "solid-js";
import type { SessionBranch } from "../../../api/types.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { createMenuControls, Menu, type MenuEntry } from "../../../components/solid/menu.tsx";
import { Popover, type PopoverHandle } from "../../../components/solid/popover.tsx";
import { formatRelativeTimestamp } from "../../../lib/format.ts";
import { t } from "../../../lib/reactive/i18n.ts";

type ChatPaneVersionsMenuProps = {
  catalog: boolean;
  branches: SessionBranch[];
  branchSwitchDisabledReason: string | null;
  onBranchSelect: (leafEntryId: string) => void;
};

let nextId = 0;

export function ChatPaneVersionsMenu(props: { menu: ChatPaneVersionsMenuProps }) {
  const id = `versions-${++nextId}`;
  const controls = createMenuControls();
  const [helpAnchor, setHelpAnchor] = createSignal<HTMLButtonElement>();
  const [helpOpen, setHelpOpen] = createSignal(false);
  let help: PopoverHandle | undefined;
  const items = createMemo((): MenuEntry[] =>
    props.menu.branches.map((branch) => {
      const relativeTime = formatRelativeTimestamp(Date.parse(branch.updatedAt ?? ""), {
        fallback: "",
      });
      return {
        id: branch.leafEntryId,
        label: branch.headline || t("chat.sessionHeader.untitledBranch"),
        class: "chat-pane__branch-item",
        disabled: branch.active || Boolean(props.menu.branchSwitchDisabledReason),
        attributes: { "data-active": branch.active ? "true" : "false" },
        content: (
          <span class="chat-pane__branch-copy">
            <span class="chat-pane__branch-headline">
              {branch.headline || t("chat.sessionHeader.untitledBranch")}
            </span>
            <span class="chat-pane__branch-meta">
              {t(
                branch.messageCount === 1
                  ? "chat.sessionHeader.oneMessage"
                  : "chat.sessionHeader.messages",
                { count: String(branch.messageCount) },
              )}
              {relativeTime ? ` · ${relativeTime}` : ""}
            </span>
          </span>
        ),
        details: branch.active ? (
          <span class="chat-pane__branch-active" aria-label={t("chat.sessionHeader.activeBranch")}>
            <Icon name="check" />
          </span>
        ) : undefined,
      };
    }),
  );
  return (
    <openclaw-chat-pane-versions-menu>
      <Show when={!props.menu.catalog && props.menu.branches.length > 1}>
        <Menu
          controls={controls}
          lazy
          id={id}
          class="chat-pane__branches-menu"
          placement="bottom-end"
          label={t("chat.sessionHeader.branches")}
          disabled={Boolean(props.menu.branchSwitchDisabledReason)}
          triggerClass="btn btn--ghost btn--icon chat-icon-btn chat-pane__branches-trigger"
          triggerAttributes={{
            title: props.menu.branchSwitchDisabledReason ?? t("chat.sessionHeader.branches"),
          }}
          trigger={<Icon name="history" />}
          items={items()}
          onSelect={(item) => props.menu.onBranchSelect(item.id)}
        >
          <div class="chat-pane__versions-heading">
            <span>{t("chat.sessionHeader.branches")}</span>
            <button
              ref={[controls.ref(), setHelpAnchor]}
              id={`${id}-help`}
              class="btn btn--ghost btn--icon chat-pane__versions-info"
              type="button"
              data-form-control=""
              autofocus
              aria-label={t("chat.sessionHeader.versionsHelpLabel")}
              aria-haspopup="dialog"
              aria-expanded={helpOpen() ? "true" : "false"}
              aria-controls={`${id}-help-content`}
              onClick={() => (helpOpen() ? help?.hide() : help?.show())}
            >
              <Icon name="info" />
            </button>
            <Show when={helpAnchor()}>
              {(anchor) => (
                <Popover
                  id={`${id}-help-content`}
                  class="chat-pane__versions-help"
                  anchor={anchor()}
                  label={t("chat.sessionHeader.versionsHelpLabel")}
                  placement="bottom-end"
                  ref={(handle) => {
                    help = handle;
                  }}
                  onOpenChange={setHelpOpen}
                >
                  {t("chat.sessionHeader.versionsHelp")}
                </Popover>
              )}
            </Show>
          </div>
        </Menu>
      </Show>
    </openclaw-chat-pane-versions-menu>
  );
}
