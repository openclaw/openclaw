import { For, createSignal } from "solid-js";
import { withPromiseModalHost } from "../../../components/promise-modal-host.ts";
import { t } from "../../../i18n/index.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { copyToClipboard } from "../../../lib/clipboard.ts";
import { downloadBlobFile } from "../../../lib/download.ts";
import { getChatAttachmentBlob } from "../attachment-payload-store.ts";
import { solidTemplate } from "./chat-composer-controls.ts";

type PrivateComposerDraft = {
  text: string;
  attachments: readonly ChatAttachment[];
  hasGoal: boolean;
  pendingReads: number;
  isCurrent: () => boolean;
  signal: AbortSignal;
};

function PrivateComposerRecoveryDialog(
  props: PrivateComposerDraft & { finish: (discard: boolean) => void },
) {
  const [copied, setCopied] = createSignal(false);
  const [error, setError] = createSignal("");
  const current = () => !props.signal.aborted && props.isCurrent();
  const copyText = async () => {
    if (!current()) {
      props.finish(false);
      return;
    }
    const didCopy = await copyToClipboard(props.text, current);
    if (current()) {
      setCopied(didCopy);
      setError(didCopy ? "" : t("chat.privateDraftReload.copyFailed"));
    }
  };
  return (
    <openclaw-modal-dialog
      label={t("chat.privateDraftReload.title")}
      description={t("chat.privateDraftReload.description")}
      onModal-cancel={() => props.finish(false)}
    >
      <section class="exec-approval-card">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">{t("chat.privateDraftReload.title")}</div>
            <div class="exec-approval-sub">{t("chat.privateDraftReload.description")}</div>
          </div>
        </div>
        {props.text && (
          <>
            <label class="field">
              <span>{t("chat.privateDraftReload.text")}</span>
              <textarea readonly rows="6" value={props.text} />
            </label>
            <button type="button" class="btn" onClick={() => void copyText()}>
              {copied() ? t("common.copied") : t("chat.privateDraftReload.copy")}
            </button>
          </>
        )}
        {props.hasGoal && <p>{t("chat.privateDraftReload.goal")}</p>}
        {props.pendingReads > 0 && <p>{t("chat.privateDraftReload.reading")}</p>}
        <For each={props.attachments} keyed={(attachment) => attachment.id}>
          {(attachment) => (
            <div class="field">
              <span>{attachment().fileName ?? attachment().mimeType}</span>
              <button
                type="button"
                class="btn"
                onClick={() => {
                  if (!current()) {
                    props.finish(false);
                    return;
                  }
                  const blob = getChatAttachmentBlob(attachment());
                  if (blob) {
                    downloadBlobFile(attachment().fileName ?? "attachment", blob);
                  } else {
                    setError(t("chat.privateDraftReload.attachmentUnavailable"));
                  }
                }}
              >
                {t("chat.privateDraftReload.download", {
                  name: attachment().fileName ?? attachment().mimeType,
                })}
              </button>
            </div>
          )}
        </For>
        {error() && <p role="alert">{error()}</p>}
        <div class="exec-approval-actions">
          <button type="button" class="btn danger" onClick={() => props.finish(current())}>
            {t("chat.privateDraftReload.discard")}
          </button>
          <button type="button" class="btn" autofocus onClick={() => props.finish(false)}>
            {t("chat.privateDraftReload.keep")}
          </button>
        </div>
      </section>
    </openclaw-modal-dialog>
  );
}

export function reviewPrivateComposerDraft(params: PrivateComposerDraft): Promise<boolean> {
  return withPromiseModalHost({ signal: params.signal, value: false }, ({ render, finish }) => {
    render(() => solidTemplate(PrivateComposerRecoveryDialog, { ...params, finish }));
  });
}
