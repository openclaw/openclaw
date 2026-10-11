import { createMemo, For, Show } from "solid-js";
import type { SkillsLibraryReadResult } from "../../../../packages/gateway-protocol/src/index.ts";
import "../../components/modal-dialog.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { libraryFileText } from "./library-files.ts";

export type LibraryPinReadProps = {
  read: SkillsLibraryReadResult;
  file: string;
  onFile: (file: string) => void;
  onClose: () => void;
};

/** Session access grants a read of one pin, never the library editor or revision history. */
export function LibraryPinRead(props: LibraryPinReadProps) {
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
      <div class="exec-approval-card skill-reader-dialog">
        <div class="exec-approval-header">
          <strong class="exec-approval-title">{props.read.entry.slug}</strong>
          <button
            type="button"
            class="btn btn--icon btn--ghost"
            aria-label={t("common.close")}
            onClick={() => props.onClose()}
          >
            <Icon name="x" />
          </button>
        </div>
        <div
          class="skill-reader-dialog__body"
          style={{ display: "grid", gap: "var(--space-4)", "min-width": "0" }}
        >
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
                class="settings-input"
                readonly
                spellcheck={false}
                rows={16}
                value={text() ?? ""}
                style={{
                  "font-family": "var(--mono)",
                  "min-width": "0",
                  "max-width": "100%",
                  "box-sizing": "border-box",
                  resize: "vertical",
                }}
              />
            </label>
          </Show>
          <details class="muted" style={{ "overflow-wrap": "anywhere", "min-width": "0" }}>
            <summary>{t("skillLibrary.technicalDetails")}</summary>
            <dl>
              <dt>{t("skillLibrary.skillId")}</dt>
              <dd>{props.read.entry.skillId}</dd>
              <dt>{t("skillLibrary.revision")}</dt>
              <dd>{props.read.entry.revision}</dd>
              <dt>{t("skillLibrary.command")}</dt>
              <dd>{props.read.entry.name}</dd>
            </dl>
          </details>
        </div>
      </div>
    </openclaw-modal-dialog>
  );
}
