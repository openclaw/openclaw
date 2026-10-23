import type { JSX } from "@solidjs/web";
import { Icon } from "../../components/solid/icon.tsx";
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
        props.library.close();
      }}
    >
      <form
        class="exec-approval-card skill-reader-dialog"
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
        <div class="exec-approval-header">
          <strong class="exec-approval-title">
            {props.editor?.title ?? t("skillLibrary.import")}
          </strong>
          <button
            type="button"
            class="btn btn--icon btn--ghost"
            aria-label={t("common.close")}
            disabled={busy()}
            onClick={() => props.library.close()}
          >
            <Icon name="x" />
          </button>
        </div>
        <div
          class={["skill-reader-dialog__body", { "skill-library-import": !props.editor }]}
          style={
            props.editor ? { display: "grid", gap: "var(--space-4)", "min-width": "0" } : undefined
          }
        >
          {props.children}
        </div>
        {props.footer}
      </form>
    </openclaw-modal-dialog>
  );
}
