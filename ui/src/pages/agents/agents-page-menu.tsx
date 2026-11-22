import { Show, createSignal, createUniqueId } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { Menu, type MenuEntry } from "../../components/solid/menu.tsx";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { t } from "../../lib/reactive/i18n.ts";

// Holds the selected agent's actions. New agent and Refresh join them on the phone.
export function AgentsPageMenu(props: {
  agentId: string | null;
  canCreateAgent: boolean;
  canSetDefault: boolean;
  canDeleteAgent: boolean;
  defaultLabel: string;
  defaultDisabled: boolean;
  pinLabel: string;
  deleteDisabled: boolean;
  onDelete: (agentId: string) => void;
  showPhoneActions: boolean;
  createLabel: string;
  createDisabled: boolean;
  onCreate: () => void;
  refreshLabel: string;
  refreshDisabled: boolean;
  onSetDefault: (agentId: string) => void;
  onTogglePinned: (agentId: string) => void;
  onRefresh: () => void;
}) {
  const id = createUniqueId();
  const [copyResult, setCopyResult] = createSignal<boolean | null>(null);
  const items = (): MenuEntry[] => [
    ...(props.showPhoneActions && props.canCreateAgent
      ? [
          {
            id: "create",
            label: props.createLabel,
            disabled: props.createDisabled,
          },
        ]
      : []),
    ...(props.agentId
      ? [
          {
            id: "copy",
            label: t("agents.copyId"),
            content: (
              <span role="status">
                <Show
                  when={copyResult() === false}
                  fallback={t(copyResult() ? "common.copied" : "agents.copyId")}
                >
                  <span class="sr-only">{t("common.copyFailed")}</span>
                  <span aria-hidden="true">{t("common.retry")}</span>
                </Show>
              </span>
            ),
            closeOnSelect: false,
          },
          ...(props.canSetDefault
            ? [{ id: "default", label: props.defaultLabel, disabled: props.defaultDisabled }]
            : []),
          { id: "pin", label: props.pinLabel },
          ...(props.canDeleteAgent
            ? [
                {
                  id: "delete",
                  label: t("common.delete"),
                  icon: <Icon name="trash" />,
                  variant: "danger" as const,
                  disabled: props.deleteDisabled,
                },
              ]
            : []),
        ]
      : []),
    ...(props.showPhoneActions
      ? [{ id: "refresh", label: props.refreshLabel, disabled: props.refreshDisabled }]
      : []),
  ];
  return (
    <Menu
      id={id}
      lazy
      class="agents-page-menu"
      label={t("browser.moreActions")}
      placement="bottom-end"
      pointerFocus="trigger"
      triggerClass="btn btn--sm agents-page-menu__trigger"
      trigger={<Icon name="moreHorizontal" />}
      items={items()}
      onBeforeShow={() => setCopyResult(null)}
      onSelect={(item) => {
        const agentId = props.agentId;
        if (item.id === "create") {
          props.onCreate();
        } else if (item.id === "refresh") {
          props.onRefresh();
        } else if (agentId && item.id === "copy") {
          void copyToClipboard(agentId).then(setCopyResult);
        } else if (agentId && item.id === "default") {
          props.onSetDefault(agentId);
        } else if (agentId && item.id === "pin") {
          props.onTogglePinned(agentId);
        } else if (agentId && item.id === "delete") {
          props.onDelete(agentId);
        }
      }}
    />
  );
}
