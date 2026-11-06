import "../../styles/skill-reader-dialog.css";
import type { JSX } from "@solidjs/web";
import { DialogHeader } from "../../components/solid/dialog-header.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import type { SkillLibraryModel } from "./library-state.ts";

export function LibraryDialog(props: {
  library: SkillLibraryModel;
  children: JSX.Element;
  footer: JSX.Element;
  editor?: { title: string; disabled: boolean };
}) {
  const current = () => props.library.state;
  const busy = () => props.library.saving() || current().busy;
  return (
    <openclaw-modal-dialog
      label={props.editor?.title ?? t("skillLibrary.import")}
      style={props.editor ? { "--openclaw-modal-width": "960px" } : undefined}
      onModal-cancel={(event: Event) => {
        // Native dismissal must not bypass the library's busy and discard checks.
        event.preventDefault();
        void props.library.close();
      }}
    >
      <form
        class="oc-dialog skill-library-dialog"
        onSubmit={(event: SubmitEvent) => {
          event.preventDefault();
          const source = current().importSource;
          if (props.editor) {
            void props.library.save();
          } else if (source) {
            void props.library.importClawHub(current().importSlug, source.slug, source.version);
          } else {
            void props.library.importFiles(current().importSelection);
          }
        }}
        onKeyDown={(event) => {
          if (
            props.editor &&
            (event.ctrlKey || event.metaKey) &&
            event.key === "Enter" &&
            !props.editor.disabled
          ) {
            event.preventDefault();
            event.currentTarget.requestSubmit();
          }
        }}
      >
        <DialogHeader
          title={props.editor?.title ?? t("skillLibrary.import")}
          closeDisabled={busy()}
          onClose={() => void props.library.close()}
        />
        <div class={["oc-dialog__body", { "skill-library-import": !props.editor }]}>
          {props.children}
        </div>
        {props.footer}
      </form>
    </openclaw-modal-dialog>
  );
}
