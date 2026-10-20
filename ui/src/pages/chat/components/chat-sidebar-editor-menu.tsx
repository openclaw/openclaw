import { Show, createUniqueId } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { Menu } from "../../../components/solid/menu.tsx";
import { EDITOR_LABELS, type FileOpenTarget, fileOpenTargets } from "../../../lib/editor-links.ts";
import { t } from "../../../lib/reactive/i18n.ts";

export function ChatSidebarEditorMenu(props: {
  absolutePath: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenEditor: (target: FileOpenTarget) => void;
}) {
  const id = createUniqueId();
  const targets = fileOpenTargets();
  return (
    <Show when={props.absolutePath}>
      <div class="sidebar-file-view__editor">
        <Menu
          id={`chat-editor-${id}`}
          class="sidebar-file-view__editor-menu"
          panelClass="sidebar-file-view__editor-panel"
          placement="bottom-end"
          open={props.open}
          onOpenChange={props.onOpenChange}
          label="Open in editor"
          triggerClass="btn btn--sm sidebar-file-view__action"
          triggerAttributes={{ title: "Open in editor" }}
          trigger={<Icon name="externalLink" />}
          items={targets.map((target) => ({
            id: target,
            label: target === "default-app" ? t("chat.fileOpen.defaultApp") : EDITOR_LABELS[target],
            class: "sidebar-file-view__editor-item",
          }))}
          onSelect={(item) => {
            const target = targets.find((candidate) => candidate === item.id);
            if (target) {
              props.onOpenEditor(target);
            }
          }}
        />
      </div>
    </Show>
  );
}
