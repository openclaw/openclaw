import "../../styles/skill-reader-dialog.css";
import { createMemo, For, Show } from "solid-js";
import type { SkillsLibraryReadResult } from "../../../../packages/gateway-protocol/src/index.ts";
import { DialogHeader } from "../../components/solid/dialog-header.tsx";
import { SettingsDisclosure } from "../../components/solid/settings-disclosure.tsx";
import "../../components/modal-dialog.tsx";
import { registerSessionSkillLibraryEnglish } from "../../i18n/locales/en-session-skill-library.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { libraryFileText } from "./library-file-text.ts";

/** Session access grants a read of one pin, never the library editor or revision history. */
export function LibraryPinRead(props: {
  read: SkillsLibraryReadResult;
  file: string;
  onFile: (file: string) => void;
  onClose: () => void;
}) {
  const text = createMemo(() => {
    if (props.file === "SKILL.md") {
      return props.read.content;
    }
    const support = props.read.files.find((file) => file.path === props.file);
    return support ? libraryFileText(support) : null;
  });
  return (
    <openclaw-modal-dialog
      label={props.read.entry.slug}
      style={{ "--openclaw-modal-width": "960px" }}
      onModal-cancel={() => props.onClose()}
    >
      <div class="oc-dialog skill-library-dialog">
        <DialogHeader title={props.read.entry.slug} onClose={() => props.onClose()} />
        <div class="oc-dialog__body">
          <p>
            {t("skillLibrary.ownerRevision", {
              owner: props.read.entry.ownerLabel,
              revision: props.read.entry.revision.slice(0, 8),
            })}
          </p>
          <p class="muted">{t("skillLibrary.session.readOnly")}</p>
          <label class="field">
            <span>{t("skillLibrary.file")}</span>
            <select
              class="settings-select"
              value={props.file}
              onChange={(event) => props.onFile(event.currentTarget.value)}
            >
              <option value="SKILL.md">SKILL.md</option>
              <For each={props.read.files} keyed={(file) => file.path}>
                {(file) => <option value={file().path}>{file().path}</option>}
              </For>
            </select>
          </label>
          <Show
            when={text() !== null}
            fallback={<p class="muted">{t("skillLibrary.binaryRead")}</p>}
          >
            <label class="field">
              <span>{props.file}</span>
              <textarea
                class="settings-input skill-library-dialog__source"
                readonly
                spellcheck="false"
                rows={16}
                value={text() ?? ""}
              />
            </label>
          </Show>
          <SettingsDisclosure
            quiet
            class="skill-library-details"
            title={t("skillLibrary.technicalDetails")}
          >
            <dl>
              <dt>{t("skillLibrary.skillId")}</dt>
              <dd>{props.read.entry.skillId}</dd>
              <dt>{t("skillLibrary.revision")}</dt>
              <dd>{props.read.entry.revision}</dd>
              <dt>{t("skillLibrary.command")}</dt>
              <dd>{props.read.entry.name}</dd>
            </dl>
          </SettingsDisclosure>
        </div>
      </div>
    </openclaw-modal-dialog>
  );
}

registerSessionSkillLibraryEnglish();
