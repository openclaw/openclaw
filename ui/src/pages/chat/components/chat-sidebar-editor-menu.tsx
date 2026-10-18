import { Show, createUniqueId } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { Menu } from "../../../components/solid/menu.tsx";
import { EDITOR_IDS, EDITOR_LABELS, type EditorId } from "../../../lib/editor-links.ts";

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
          label="Open in editor"
          triggerClass="btn btn--sm sidebar-file-view__action"
          triggerAttributes={{ title: "Open in editor" }}
          trigger={<Icon name="externalLink" />}
          items={EDITOR_IDS.map((editor) => ({
            id: editor,
            label: EDITOR_LABELS[editor],
            class: "sidebar-file-view__editor-item",
            attributes: { value: editor },
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
