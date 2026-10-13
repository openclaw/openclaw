import { For, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import "../../../components/web-awesome.ts";
import { EDITOR_IDS, EDITOR_LABELS, type EditorId } from "../../../lib/editor-links.ts";

export function ChatSidebarEditorMenu(props: {
  absolutePath: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenEditor: (editor: EditorId) => void;
}) {
  return (
    <Show when={props.absolutePath}>
      <div class="sidebar-file-view__editor">
        <wa-dropdown
          class="sidebar-file-view__editor-menu"
          placement="bottom-end"
          prop:open={props.open}
          onWa-select={(event) => {
            const editor = EDITOR_IDS.find((id) => id === event.detail.item.value);
            if (editor) {
              props.onOpenEditor(editor);
            }
          }}
          onWa-show={() => props.onOpenChange(true)}
          onWa-hide={() => props.onOpenChange(false)}
        >
          <button
            slot="trigger"
            class="btn btn--sm sidebar-file-view__action"
            type="button"
            title="Open in editor"
            aria-label="Open in editor"
          >
            <Icon name="externalLink" />
          </button>
          <For each={EDITOR_IDS}>
            {(editor) => (
              <wa-dropdown-item class="sidebar-file-view__editor-item" value={editor}>
                {EDITOR_LABELS[editor]}
              </wa-dropdown-item>
            )}
          </For>
        </wa-dropdown>
      </div>
    </Show>
  );
}
