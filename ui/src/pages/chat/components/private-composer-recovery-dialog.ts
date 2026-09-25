import { html, nothing } from "lit";
import { withPromiseModalHost } from "../../../components/promise-modal-host.ts";
import { t } from "../../../i18n/index.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { copyToClipboard } from "../../../lib/clipboard.ts";
import { downloadBlobFile } from "../../../lib/download.ts";
import { getChatAttachmentBlob } from "../attachment-payload-store.ts";

export function reviewPrivateComposerDraft(params: {
  text: string;
  attachments: readonly ChatAttachment[];
  hasGoal: boolean;
  pendingReads: number;
  isCurrent: () => boolean;
  signal: AbortSignal;
}): Promise<boolean> {
  return withPromiseModalHost({ signal: params.signal, value: false }, ({ render, finish }) => {
    let copied = false;
    let error = "";
    const current = () => !params.signal.aborted && params.isCurrent();
    const content = () => html` <openclaw-modal-dialog
      label=${t("chat.privateDraftReload.title")}
      description=${t("chat.privateDraftReload.description")}
      @modal-cancel=${() => finish(false)}
    >
      <section class="exec-approval-card">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">${t("chat.privateDraftReload.title")}</div>
            <div class="exec-approval-sub">${t("chat.privateDraftReload.description")}</div>
          </div>
        </div>
        ${
          params.text
            ? html`
                <label class="field"
                  ><span>${t("chat.privateDraftReload.text")}</span>
                  <textarea readonly rows="6" .value=${params.text}></textarea>
                </label>
                <button
                  type="button"
                  class="btn"
                  @click=${async () => {
                    if (!current()) {
                      finish(false);
                      return;
                    }
                    copied = await copyToClipboard(params.text, current);
                    if (current()) {
                      error = copied ? "" : t("chat.privateDraftReload.copyFailed");
                      render(content);
                    }
                  }}
                >
                  ${copied ? t("common.copied") : t("chat.privateDraftReload.copy")}
                </button>
              `
            : nothing
        }
        ${params.hasGoal ? html`<p>${t("chat.privateDraftReload.goal")}</p>` : nothing}
        ${params.pendingReads ? html`<p>${t("chat.privateDraftReload.reading")}</p>` : nothing}
        ${params.attachments.map(
          (attachment) => html`
            <div class="field">
              <span>${attachment.fileName ?? attachment.mimeType}</span>
              <button
                type="button"
                class="btn"
                @click=${() => {
                  if (!current()) {
                    finish(false);
                    return;
                  }
                  const blob = getChatAttachmentBlob(attachment);
                  if (blob) {
                    downloadBlobFile(attachment.fileName ?? "attachment", blob);
                  } else {
                    error = t("chat.privateDraftReload.attachmentUnavailable");
                    render(content);
                  }
                }}
              >
                ${t("chat.privateDraftReload.download", { name: attachment.fileName ?? attachment.mimeType })}
              </button>
            </div>
          `,
        )}
        ${error ? html`<p role="alert">${error}</p>` : nothing}
        <div class="exec-approval-actions">
          <button type="button" class="btn danger" @click=${() => finish(current())}>
            ${t("chat.privateDraftReload.discard")}
          </button>
          <button type="button" class="btn" autofocus @click=${() => finish(false)}>
            ${t("chat.privateDraftReload.keep")}
          </button>
        </div>
      </section>
    </openclaw-modal-dialog>`;
    render(content);
  });
}
