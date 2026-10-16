import { createSignal, onCleanup } from "solid-js";
import { t } from "../../../i18n/index.ts";
import { downloadBlobFile } from "../../../lib/download.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import type {
  AttachmentSidebarRuntime,
  ChatDetailPanelContent,
} from "./chat-sidebar-content-types.ts";

export function createAttachmentDownload(
  content: () => ChatDetailPanelContent | null,
  runtime: () => AttachmentSidebarRuntime,
  isConnected: () => boolean,
) {
  let request: AbortController | null = null;
  const [pending, setPending] = createSignal(false, { ownedWrite: true });
  const [error, setError] = createSignal<string | null>(null, { ownedWrite: true });
  onCleanup(() => request?.abort());

  return {
    get pending() {
      return pending();
    },
    get error() {
      return error();
    },
    cancel() {
      request?.abort();
      request = null;
      setPending(false);
      setError(null);
    },
    onDownload: async () => {
      const attachment = content();
      if (attachment?.kind !== "attachment" || !attachment.download || request) {
        return;
      }
      const currentRequest = new AbortController();
      const { connectionEpoch, sessionKey, agentId } = runtime();
      request = currentRequest;
      setError(null);
      setPending(true);
      const current = () => {
        const scope = runtime();
        return (
          isConnected() &&
          content() === attachment &&
          request === currentRequest &&
          scope.connectionEpoch === connectionEpoch &&
          scope.sessionKey === sessionKey &&
          scope.agentId === agentId &&
          !currentRequest.signal.aborted
        );
      };
      try {
        const blob = await attachment.download(currentRequest.signal);
        if (!current()) {
          return;
        }
        if (!blob) {
          throw new Error(t("chat.attachments.unavailable"));
        }
        downloadBlobFile(attachment.title, blob);
      } catch (cause) {
        if (current()) {
          setError(formatUiError(cause));
        }
      } finally {
        if (request === currentRequest) {
          request = null;
          setPending(false);
        }
      }
    },
  };
}
