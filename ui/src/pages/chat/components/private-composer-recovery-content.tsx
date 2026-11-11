import { For, createSignal } from "solid-js";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { copyToClipboard } from "../../../lib/clipboard.ts";
import { downloadBlobFile } from "../../../lib/download.ts";
import { t, registerEnglishCatalog } from "../../../lib/reactive/i18n.ts";
import { getChatAttachmentBlob } from "../attachment-payload-store.ts";
import type { PrivateComposerDraft } from "./private-composer-recovery-dialog.tsx";

registerEnglishCatalog(registerChatComposerEnglish);

export function PrivateComposerRecoveryDialog(
  props: PrivateComposerDraft & { finish: (discard: boolean) => void },
) {
  const [copied, setCopied] = createSignal(false);
  let keepButton!: HTMLButtonElement;
  const [error, setError] = createSignal<"copyFailed" | "attachmentUnavailable">();
  const current = () => !props.signal.aborted && props.isCurrent();
  const title = () => props.labels?.title ?? t("chat.privateDraftReload.title");
  const description = () => props.labels?.description ?? t("chat.privateDraftReload.description");
  const copyText = async () => {
    if (!current()) {
      props.finish(false);
      return;
    }
    const didCopy = await copyToClipboard(props.text, current);
    if (current()) {
      setCopied(didCopy);
      setError(didCopy ? undefined : "copyFailed");
    }
  };
  return (
    <openclaw-modal-dialog
      prop:initialFocus={() => keepButton}
      label={title()}
      description={description()}
      onModal-cancel={() => props.finish(false)}
    >
      <section class="exec-approval-card">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">{title()}</div>
            <div class="exec-approval-sub">{description()}</div>
          </div>
        </div>
        {props.text && (
          <>
            <label class="field">
              <span>{props.labels?.text ?? t("chat.privateDraftReload.text")}</span>
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
                    setError("attachmentUnavailable");
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
        {error() && <p role="alert">{t(`chat.privateDraftReload.${error()}`)}</p>}
        <openclaw-modal-actions class="exec-approval-actions">
          <button
            ref={(element) => {
              keepButton = element;
            }}
            type="button"
            class="btn"
            autofocus
            onClick={() => props.finish(false)}
          >
            {t("chat.privateDraftReload.keep")}
          </button>
          <button type="button" class="btn danger" onClick={() => props.finish(current())}>
            {props.labels?.discard ?? t("chat.privateDraftReload.discard")}
          </button>
        </openclaw-modal-actions>
      </section>
    </openclaw-modal-dialog>
  );
}
