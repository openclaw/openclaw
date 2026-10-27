import { Show, createUniqueId } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { Menu } from "../../../components/solid/menu.tsx";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import { EDITOR_IDS, EDITOR_LABELS, type EditorId } from "../../../lib/editor-links.ts";
import { t } from "../../../lib/reactive/i18n.ts";

registerFilePreviewEnglish();

export function ChatSidebarEditorMenu(props: {
  absolutePath: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenEditor: (editor: EditorId) => void;
}) {
  const id = createUniqueId();
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
          label={t("chat.detailPanel.openInEditor")}
          triggerClass="btn btn--sm sidebar-file-view__action"
          triggerAttributes={{ title: t("chat.detailPanel.openInEditor") }}
          trigger={<Icon name="externalLink" />}
          items={EDITOR_IDS.map((editor) => ({
            id: editor,
            label: EDITOR_LABELS[editor],
            class: "sidebar-file-view__editor-item",
          }))}
          onSelect={(item) => {
            const editor = EDITOR_IDS.find((candidate) => candidate === item.id);
            if (editor) {
              props.onOpenEditor(editor);
            }
          }}
        />
      </div>
    </Show>
  );
}
