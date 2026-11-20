import { Icon } from "../../../components/solid/icon.tsx";
import type { MenuEntry, MenuHandle, MenuItem } from "../../../components/solid/menu.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { uploadsEnabled } from "../../../lib/uploads.ts";
import { useNativeAttachmentSourceMenu } from "./chat-attachment-picker-policy.ts";
import type { ChatComposerPlusMenuContentProps } from "./chat-composer-plus-menu.types.ts";

export function composerAttachmentMenuItems(menu: ChatComposerPlusMenuContentProps): MenuEntry[] {
  if (!uploadsEnabled(menu.attachments.uploadConfig)) {
    return [];
  }
  const sources: MenuEntry[] = [];
  const mediaOption = menu.attachments.imagesOnly
    ? (["photo", "image", t("chat.composer.attachPhoto")] as const)
    : (["media", "image", t("chat.composer.attachMedia")] as const);
  const nativeSourceMenu = useNativeAttachmentSourceMenu();
  for (const [id, icon, label] of nativeSourceMenu
    ? ([["file", "paperclip", t("chat.composer.attach")]] as const)
    : ([
        ["camera", "camera", t("chat.composer.cameraInput")],
        mediaOption,
        ...(menu.attachments.imagesOnly
          ? []
          : ([["file", "paperclip", t("chat.composer.attachFileOption")]] as const)),
      ] as const)) {
    sources.push({
      id,
      label,
      class: nativeSourceMenu
        ? "agent-chat__attach-menu-option agent-chat__capability-menu-item"
        : "agent-chat__attach-menu-option",
      icon: <Icon name={icon} />,
    });
  }
  return [
    {
      kind: "group",
      id: "attachment-sources",
      class: sources.length === 1 ? undefined : "agent-chat__attachment-sources",
      items: sources,
    },
  ];
}

export function handleComposerAttachmentSelection(
  value: string,
  event: CustomEvent<MenuItem>,
  menu: MenuHandle,
  props: ChatComposerPlusMenuContentProps,
): boolean {
  if (
    !uploadsEnabled(props.attachments.uploadConfig) ||
    (value !== "camera" && value !== "photo" && value !== "file" && value !== "media")
  ) {
    return false;
  }
  event.preventDefault();
  const { overlay } = menu;
  const { surface } = overlay;
  props.inputHandle.open(value, () => {
    const durations = ["--oc-overlay-show-duration", "--oc-overlay-hide-duration"].map((name) => ({
      name,
      value: surface.style.getPropertyValue(name),
      priority: surface.style.getPropertyPriority(name),
    }));
    for (const { name } of durations) {
      surface.style.setProperty(name, "0s");
    }
    try {
      return overlay.request(false, "none") && !surface.matches(":popover-open");
    } finally {
      for (const { name, value: duration, priority } of durations) {
        if (duration) {
          surface.style.setProperty(name, duration, priority);
        } else {
          surface.style.removeProperty(name);
        }
      }
    }
  });
  return true;
}
