import { createMemo, createSignal, createUniqueId } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { Menu, type MenuHandle, type MenuItem } from "../../../components/solid/menu.tsx";
import { t } from "../../../lib/reactive/i18n.ts";

export type WidgetAction = "copy" | "download" | "raw-details";
export type WidgetRawDetailsLabel =
  | "chat.toolCards.hideRawDetails"
  | "chat.toolCards.showRawDetails";

export function WidgetCardMenu(props: {
  canExportImage: boolean;
  hasRawDetails: boolean;
  onAction: (value: WidgetAction, menu: HTMLElement) => WidgetRawDetailsLabel | void;
}) {
  const id = createUniqueId();
  let handle: MenuHandle | undefined;
  const [rawDetailsLabel, setRawDetailsLabel] = createSignal<WidgetRawDetailsLabel>(
    "chat.toolCards.showRawDetails",
  );
  const items = createMemo<MenuItem[]>(() => {
    const values: WidgetAction[] = [
      ...(props.canExportImage ? ["copy" as const, "download" as const] : []),
      ...(props.hasRawDetails ? ["raw-details" as const] : []),
    ];
    return values.map((value) => {
      const options = {
        copy: { icon: "copyImage", labelKey: "chat.toolCards.copyAsImage" },
        download: { icon: "download", labelKey: "chat.toolCards.downloadAsImage" },
        "raw-details": { icon: "fileText", labelKey: "chat.toolCards.showRawDetails" },
      } as const;
      const option = options[value];
      const label = t(value === "raw-details" ? rawDetailsLabel() : option.labelKey);
      return {
        id: value,
        label,
        class: "session-menu__item",
        attributes: { value },
        icon: (
          <span class="session-menu__icon" aria-hidden="true">
            <Icon name={option.icon} />
          </span>
        ),
        content: (
          <span
            class="session-menu__text"
            data-raw-label={value === "raw-details" ? "" : undefined}
          >
            {label}
          </span>
        ),
      };
    });
  });
  return (
    <Menu
      lazy="while-open"
      id={`widget-actions-${id}`}
      class="chat-tool-card__widget-actions"
      panelClass="chat-tool-card__widget-actions-panel"
      placement="bottom-end"
      label={t("chat.toolCards.widgetActions")}
      triggerClass="btn btn--ghost btn--icon chat-tool-card__widget-actions-trigger"
      triggerAttributes={{ title: t("chat.toolCards.widgetActions") }}
      trigger={<Icon name="moreHorizontal" />}
      items={items()}
      ref={(next) => {
        handle = next;
      }}
      onSelect={(item) => {
        if (handle && (item.id === "copy" || item.id === "download" || item.id === "raw-details")) {
          const caption = props.onAction(item.id, handle.overlay.surface);
          if (caption) {
            setRawDetailsLabel(caption);
          }
        }
      }}
    />
  );
}
