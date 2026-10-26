import { createUniqueId } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { Menu } from "../../../components/solid/menu.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import type { FileSessionAttachment } from "./chat-file-session-attachment.ts";

export function FileSessionMenu(props: {
  attachment?: FileSessionAttachment;
  onViewSource?: () => void;
}) {
  const id = createUniqueId();
  return (
    <Menu
      id={`file-session-${id}`}
      label={t("chat.detailPanel.moreFileActions")}
      panelClass="sidebar-file-view__menu"
      trigger={<Icon name="moreHorizontal" />}
      triggerClass="session-panel-rail__button sidebar-file-view__action"
      items={[
        ...(props.attachment
          ? [
              {
                id: "attach-session",
                label: t("chat.detailPanel.attachToSession"),
                icon: <Icon name="paperclip" />,
                disabled: props.attachment.disabled,
              },
            ]
          : []),
        ...(props.onViewSource
          ? [
              {
                id: "source",
                label: t("chat.detailPanel.viewSource"),
                icon: <Icon name="codeXml" />,
              },
            ]
          : []),
      ]}
      onSelect={(item) => {
        if (item.id === "attach-session") {
          props.attachment?.attach();
        } else if (item.id === "source") {
          props.onViewSource?.();
        }
      }}
    />
  );
}
