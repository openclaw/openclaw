import { createUniqueId } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { Menu, type MenuEntry } from "../../components/solid/menu.tsx";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { showToast } from "../../lib/toast.ts";

async function copyAgentId(id: string) {
  const copied = await copyToClipboard(id);
  showToast({
    severity: copied ? "success" : "error",
    message: t(copied ? "common.copied" : "common.copyFailed"),
  });
}

// Holds the selected agent's actions. New agent and Refresh join them on the phone.
export function AgentsPageMenu(props: {
  agentId: string | null;
  defaultLabel: string;
  defaultDisabled: boolean;
  pinLabel: string;
  deleteDisabled: boolean;
  onDelete: (agentId: string) => void;
  showPhoneActions: boolean;
  createLabel: string;
  createDisabled: boolean;
  createDisabledReason?: string;
  onCreate: () => void;
  refreshLabel: string;
  refreshDisabled: boolean;
  onSetDefault: (agentId: string) => void;
  onTogglePinned: (agentId: string) => void;
  onRefresh: () => void;
}) {
  const id = createUniqueId();
  const items = (): MenuEntry[] => [
    ...(props.showPhoneActions
      ? [
          {
            id: "create",
            label: props.createLabel,
            disabled: props.createDisabled,
            focusableWhenDisabled: Boolean(props.createDisabledReason),
            details: props.createDisabledReason,
          },
        ]
      : []),
    ...(props.agentId
      ? [
          { id: "copy", label: t("agents.copyId") },
          { id: "default", label: props.defaultLabel, disabled: props.defaultDisabled },
          { id: "pin", label: props.pinLabel },
          {
            id: "delete",
            label: t("common.delete"),
            icon: <Icon name="trash" />,
            variant: "danger" as const,
            disabled: props.deleteDisabled,
          },
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
      onSelect={(item) => {
        const agentId = props.agentId;
        if (item.id === "create") {
          props.onCreate();
        } else if (item.id === "refresh") {
          props.onRefresh();
        } else if (agentId && item.id === "copy") {
          void copyAgentId(agentId);
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
