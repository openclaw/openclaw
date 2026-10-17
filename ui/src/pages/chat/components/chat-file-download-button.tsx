import { createSignal, onCleanup } from "solid-js";
import type { SessionFileDownload } from "../../../api/session-file-download.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import "../../../components/tooltip.ts";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { showToast } from "../../../lib/toast.ts";

registerFilePreviewEnglish();

export function FileDownloadButton(props: {
  scopeKey: string;
  download: (signal: AbortSignal) => Promise<SessionFileDownload | null>;
  class: string;
  disabled?: boolean;
}) {
  const [pending, setPending] = createSignal(false);
  let request: AbortController | null = null;
  onCleanup(() => request?.abort());
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
        ref={(button) =>
          button.addEventListener("click", (event) => {
            event.stopPropagation();
            void download();
          })
        }
      >
        <Icon name="download" />
      </button>
    </openclaw-tooltip>
  );
}
