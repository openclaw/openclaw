import { For, createSignal, untrack } from "solid-js";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import { copyToClipboard } from "../../../lib/clipboard.ts";
import { downloadTextFile } from "../../../lib/download.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { FileSidebarContent } from "./chat-sidebar-content-types.ts";

registerFilePreviewEnglish();

export type FileDraft = {
  name: string;
  path: string;
  context: FileSidebarContent["draftContext"];
  content: string;
  isCurrent: () => boolean;
  discard: () => boolean;
};

export function FileDraftRecoveryDialog(props: {
  drafts: readonly FileDraft[];
  settled: () => boolean;
  finish: () => void;
}) {
  // Review the opening batch; successful discards remove entries from this dialog.
  const [remaining, setRemaining] = createSignal(untrack(() => [...props.drafts]));
  const [error, setError] = createSignal("");
  const [copied, setCopied] = createSignal<FileDraft>();
  const current = (draft: FileDraft) => {
    if (props.settled()) {
      return false;
    }
    if (!remaining().includes(draft) || !draft.isCurrent()) {
      setError(t("chat.detailPanel.draftRecovery.changed"));
      return false;
    }
    return true;
  };
  const copyDraft = async (entry: FileDraft) => {
    if (!current(entry)) {
      return;
    }
    const ok = await copyToClipboard(entry.content, () => current(entry));
    if (current(entry)) {
      setCopied(ok ? entry : undefined);
      setError(ok ? "" : t("chat.detailPanel.draftRecovery.copyFailed"));
    }
  };
  return (
    <openclaw-modal-dialog
      label={t("chat.detailPanel.draftRecovery.review")}
      description={t("chat.detailPanel.draftRecovery.description")}
      onModal-cancel={() => props.finish()}
    >
      <section class="exec-approval-card exec-approval-modal-stack">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">{t("chat.detailPanel.draftRecovery.review")}</div>
            <div class="exec-approval-sub">{t("chat.detailPanel.draftRecovery.description")}</div>
          </div>
        </div>
        <For each={remaining()}>
          {(entry) => (
            <section
              role="group"
              style={{ "overflow-wrap": "anywhere" }}
              aria-label={[
                entry.path,
                entry.context?.sessionTitle,
                entry.context?.paneLabel,
                entry.context?.sessionKey,
              ]
                .filter(Boolean)
                .join(" — ")}
            >
              {entry.context ? (
                <>
                  <div class="exec-approval-title">{entry.context.sessionTitle}</div>
                  <div class="exec-approval-sub">{entry.context.paneLabel}</div>
                  <div class="exec-approval-sub">{entry.context.sessionKey}</div>
                </>
              ) : undefined}
              <label class="field">
                <span>{entry.path}</span>
                <textarea readonly rows="6" value={entry.content} />
              </label>
              <div class="exec-approval-actions">
                <button type="button" class="btn" onClick={() => void copyDraft(entry)}>
                  {copied() === entry
                    ? t("common.copied")
                    : t("chat.detailPanel.draftRecovery.copy", { name: entry.name })}
                </button>
                <button
                  type="button"
                  class="btn"
                  onClick={() => {
                    if (current(entry)) {
                      downloadTextFile(entry.name, entry.content);
                    }
                  }}
                >
                  {t("chat.detailPanel.draftRecovery.download", { name: entry.name })}
                </button>
                <button
                  type="button"
                  class="btn danger"
                  onClick={() => {
                    if (!current(entry) || !entry.discard()) {
                      return;
                    }
                    const next = remaining().filter((item) => item !== entry);
                    setRemaining(next);
                    setError("");
                    if (!next.length) {
                      props.finish();
                    }
                  }}
                >
                  {t("chat.detailPanel.draftRecovery.discard", { name: entry.name })}
                </button>
              </div>
            </section>
          )}
        </For>
        {error() ? <p role="alert">{error()}</p> : undefined}
        <openclaw-modal-actions class="exec-approval-actions">
          <button type="button" class="btn" autofocus onClick={() => props.finish()}>
            {t("chat.detailPanel.draftRecovery.keep")}
          </button>
        </openclaw-modal-actions>
      </section>
    </openclaw-modal-dialog>
  );
}
