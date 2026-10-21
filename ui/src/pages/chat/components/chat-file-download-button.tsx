import { createSignal, onSettled } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import "../../../components/tooltip.ts";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import { downloadBlobFile } from "../../../lib/download.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { showToast } from "../../../lib/toast.ts";
import type { FileReaderDownload } from "./chat-sidebar-content-types.ts";

registerFilePreviewEnglish();

export function FileDownloadButton(props: {
  scopeKey: string;
  download: (signal: AbortSignal) => Promise<FileReaderDownload | null>;
  class: string;
  disabled?: boolean;
  showLabel?: boolean;
}) {
  const [pending, setPending] = createSignal(false);
  let request: AbortController | null = null;
  onSettled(() => () => request?.abort());
  const download = async () => {
    if (request || props.disabled) {
      return;
    }
    const controller = new AbortController();
    const scopeKey = props.scopeKey;
    request = controller;
    setPending(true);
    const current = () => !controller.signal.aborted && props.scopeKey === scopeKey;
    try {
      const file = await props.download(controller.signal);
      if (file && current()) {
        if ("blob" in file) {
          downloadBlobFile(file.filename, file.blob);
          return;
        }
        // The browser owns the byte stream and save progress, not a JavaScript Blob.
        const link = document.createElement("a");
        link.href = file.url;
        link.download = file.filename;
        link.click();
      }
    } catch (error) {
      if (current()) {
        showToast({
          message: t("chat.detailPanel.downloadFailed", { error: formatUiError(error) }),
        });
      }
    } finally {
      request = null;
      if (!controller.signal.aborted) {
        setPending(false);
      }
    }
  };
  const label = () =>
    t(pending() ? "chat.detailPanel.downloading" : "chat.detailPanel.downloadFile");
  return (
    <openclaw-tooltip prop:content={label()}>
      <button
        class={props.class}
        type="button"
        aria-label={label()}
        disabled={props.disabled || pending()}
        onClick={(event) => {
          event.stopPropagation();
          void download();
        }}
      >
        <Icon name="download" />
        {props.showLabel ? (
          <span>{t(pending() ? "chat.detailPanel.downloading" : "chat.attachments.download")}</span>
        ) : undefined}
      </button>
    </openclaw-tooltip>
  );
}
