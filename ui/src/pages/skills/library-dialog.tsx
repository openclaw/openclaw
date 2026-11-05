import "../../styles/skill-reader-dialog.css";
import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
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
            void props.library.importSource({ kind: "clawhub", ...source });
          } else if (current().importUrl.trim()) {
            void props.library.importSource({
              kind: "url",
              url: current().importUrl.trim(),
              path: current().importPath.trim(),
              ref: current().importRef.trim() || undefined,
            });
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

export function LibrarySourceFields(props: { library: SkillLibraryModel }) {
  const current = () => props.library.state;
  const busy = () => props.library.saving() || current().busy;
  return (
    <Show when={!current().importSource}>
      <label class="field">
        <span>{t("skillLibrary.sourceUrl")}</span>
        <input
          class="settings-input"
          type="url"
          name="library-import-url"
          value={current().importUrl}
          disabled={busy()}
          onInput={(event) =>
            props.library.edit((state) => {
              state.importUrl = event.currentTarget.value;
              state.importSelection = [];
            })
          }
        />
        <small class="settings-row__desc">{t("skillLibrary.sourceUrlHelp")}</small>
      </label>
      <Show when={current().importUrl.trim()}>
        <For each={["importPath", "importRef"] as const} keyed={false}>
          {(name) => (
            <label class="field">
              <span>
                {t(name() === "importPath" ? "skillLibrary.sourcePath" : "skillLibrary.sourceRef")}
              </span>
              <input
                class="settings-input"
                value={current()[name()]}
                disabled={busy()}
                onInput={(event) => {
                  const field = name();
                  const value = event.currentTarget.value;
                  props.library.edit((state) => {
                    state[field] = value;
                  });
                }}
              />
            </label>
          )}
        </For>
      </Show>
    </Show>
  );
}
