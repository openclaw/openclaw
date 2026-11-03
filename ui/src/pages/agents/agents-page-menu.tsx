import { createUniqueId } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { Menu, type MenuEntry } from "../../components/solid/menu.tsx";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { showToast } from "../../lib/toast.ts";

async function copyAgentId(id: string) {
  const copied = await copyToClipboard(id);
  showToast({ message: t(copied ? "common.copied" : "common.copyFailed") });
}

// Phone widths swap the toolbar's secondary actions for this menu; both run the same actions.
export function AgentsPageMenu(props: {
  agentId: string | null;
  defaultLabel: string;
  defaultDisabled: boolean;
  pinLabel: string;
  refreshLabel: string;
  refreshDisabled: boolean;
  onSetDefault: (agentId: string) => void;
  onTogglePinned: (agentId: string) => void;
  onRefresh: () => void;
}) {
  const id = createUniqueId();
  const items = (): MenuEntry[] => [
    ...(props.agentId
      ? [
          { id: "copy", label: t("agents.copyId") },
          { id: "default", label: props.defaultLabel, disabled: props.defaultDisabled },
          { id: "pin", label: props.pinLabel },
        ]
      : []),
    { id: "refresh", label: props.refreshLabel, disabled: props.refreshDisabled },
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
        if (item.id === "refresh") {
          props.onRefresh();
        } else if (agentId && item.id === "copy") {
          void copyAgentId(agentId);
        } else if (agentId && item.id === "default") {
          props.onSetDefault(agentId);
        } else if (agentId && item.id === "pin") {
          props.onTogglePinned(agentId);
        }
      }}
    />
  );
}
