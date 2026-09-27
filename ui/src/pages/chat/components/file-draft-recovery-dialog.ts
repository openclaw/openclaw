import { html, nothing } from "lit";
import { withPromiseModalHost } from "../../../components/promise-modal-host.ts";
import { t } from "../../../i18n/index.ts";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import { copyToClipboard } from "../../../lib/clipboard.ts";
import { downloadTextFile } from "../../../lib/download.ts";
import type { FileSidebarContent } from "./chat-sidebar-content-types.ts";

registerFilePreviewEnglish();

export function reviewFileDrafts(
  drafts: readonly {
    name: string;
    path: string;
    context: FileSidebarContent["draftContext"];
    content: string;
    isCurrent: () => boolean;
    discard: () => boolean;
  }[],
): Promise<void> {
  return withPromiseModalHost<void>(undefined, (modal) => {
    const { render, finish } = modal;
    let remaining = [...drafts];
    let error = "";
    let copied: (typeof drafts)[number] | undefined;
    const current = (draft: (typeof drafts)[number]) => {
      if (modal.settled) {
        return false;
      }
      if (!remaining.includes(draft) || !draft.isCurrent()) {
        error = t("chat.detailPanel.draftRecovery.changed");
        render(content);
        return false;
      }
      return true;
    };
    const content = () => html`
      <openclaw-modal-dialog
        label=${t("chat.detailPanel.draftRecovery.review")}
        description=${t("chat.detailPanel.draftRecovery.description")}
        @modal-cancel=${() => finish()}
      >
        <section class="exec-approval-card exec-approval-modal-stack">
          <div class="exec-approval-header">
            <div>
              <div class="exec-approval-title">${t("chat.detailPanel.draftRecovery.review")}</div>
              <div class="exec-approval-sub">
                ${t("chat.detailPanel.draftRecovery.description")}
              </div>
            </div>
          </div>
          ${remaining.map(
            (draft) => html`
              <section
                role="group"
                style="overflow-wrap: anywhere"
                aria-label=${[draft.path, draft.context?.sessionTitle, draft.context?.paneLabel, draft.context?.sessionKey].filter(Boolean).join(" — ")}
              >
                ${
                  draft.context
                    ? html`
                        <div class="exec-approval-title">${draft.context.sessionTitle}</div>
                        <div class="exec-approval-sub">${draft.context.paneLabel}</div>
                        <div class="exec-approval-sub">${draft.context.sessionKey}</div>
                      `
                    : nothing
                }
                <label class="field">
                  <span>${draft.path}</span>
                  <textarea readonly rows="6" .value=${draft.content}></textarea>
                </label>
                <div class="exec-approval-actions">
                  <button
                    type="button"
                    class="btn"
                    @click=${async () => {
                      if (!current(draft)) {
                        return;
                      }
                      const ok = await copyToClipboard(draft.content, () => current(draft));
                      if (current(draft)) {
                        copied = ok ? draft : undefined;
                        error = ok ? "" : t("chat.detailPanel.draftRecovery.copyFailed");
                        render(content);
                      }
                    }}
                  >
                    ${copied === draft ? t("common.copied") : t("chat.detailPanel.draftRecovery.copy", { name: draft.name })}
                  </button>
                  <button
                    type="button"
                    class="btn"
                    @click=${() => {
                      if (current(draft)) {
                        downloadTextFile(draft.name, draft.content);
                      }
                    }}
                  >
                    ${t("chat.detailPanel.draftRecovery.download", { name: draft.name })}
                  </button>
                  <button
                    type="button"
                    class="btn danger"
                    @click=${() => {
                      if (!current(draft) || !draft.discard()) {
                        return;
                      }
                      remaining = remaining.filter((item) => item !== draft);
                      error = "";
                      if (remaining.length) {
                        render(content);
                      } else {
                        finish();
                      }
                    }}
                  >
                    ${t("chat.detailPanel.draftRecovery.discard", { name: draft.name })}
                  </button>
                </div>
              </section>
            `,
          )}
          ${error ? html`<p role="alert">${error}</p>` : nothing}
          <div class="exec-approval-actions">
            <button type="button" class="btn" autofocus @click=${() => finish()}>
              ${t("chat.detailPanel.draftRecovery.keep")}
            </button>
          </div>
        </section>
      </openclaw-modal-dialog>
    `;
    render(content);
  });
}
