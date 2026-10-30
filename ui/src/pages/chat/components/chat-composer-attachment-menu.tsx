import { lazy } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import type { MenuEntry } from "../../../components/solid/menu.tsx";
import { registerChatSketchEnglish } from "../../../i18n/locales/en-chat-sketch.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { showToast } from "../../../lib/toast.ts";
import { uploadsEnabled } from "../../../lib/uploads.ts";
import { useNativeAttachmentSourceMenu } from "./chat-attachment-picker-policy.ts";
import type { ChatComposerPlusMenuContentProps } from "./chat-composer-plus-menu.types.ts";

registerEnglishCatalog(registerChatSketchEnglish);

const SketchDialog = lazy(() => import("./chat-sketch-dialog.tsx"), { export: "SketchDialog" });

export function composerAttachmentMenuItems(menu: ChatComposerPlusMenuContentProps): MenuEntry[] {
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
        // Image-only composers keep the single picker's file input, filtered to images.
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
    {
      id: "sketch",
      label: t("chat.composer.drawSketch"),
      class: "agent-chat__attach-menu-option agent-chat__capability-menu-item",
      icon: <Icon name="pencil" />,
    },
  ];
}

export function selectComposerAttachment(
  value: string,
  readMenu: () => ChatComposerPlusMenuContentProps,
): boolean {
  const props = readMenu();
  if (!uploadsEnabled(props.attachments.uploadConfig)) {
    return false;
  }
  if (value === "sketch") {
    const readControls = () => readMenu().attachments;
    const signal = props.attachments.readSignal ?? props.attachments.attachmentReads?.readSignal;
    void SketchDialog.preload()
      .then(({ openChatSketch }) => {
        const current = readControls();
        if (signal === (current.readSignal ?? current.attachmentReads?.readSignal)) {
          return openChatSketch(readControls);
        }
        return undefined;
      })
      .catch(() => {
        if (!signal?.aborted) {
          showToast({ message: t("chat.composer.sketchFailed"), severity: "error" });
        }
      });
    return true;
  }
  if (value === "camera" || value === "photo" || value === "file" || value === "media") {
    props.inputHandle.open(value);
    return true;
  }
  return false;
}
