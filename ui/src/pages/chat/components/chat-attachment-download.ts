import { createSignal, onCleanup } from "solid-js";
import { t } from "../../../i18n/index.ts";
import { downloadBlobFile } from "../../../lib/download.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { createDetailOperationPresentation } from "./chat-detail-panel-operation-lifetime.ts";
import type {
  AttachmentSidebarRuntime,
  ChatDetailPanelContent,
} from "./chat-sidebar-content-types.ts";

export function createAttachmentDownload(
  content: () => ChatDetailPanelContent | null,
  runtime: () => AttachmentSidebarRuntime,
  isConnected: () => boolean,
) {
  let request: { controller: AbortController } | null = null;
  const presentation = createDetailOperationPresentation();
  const [error, setError] = createSignal<string | null>(null, { ownedWrite: true });
  const retire = () => {
    request?.controller.abort();
    presentation.retire();
    request = null;
  };
  onCleanup(retire);

  return {
    get pending() {
      return presentation.pending();
    },
    get error() {
      return error();
    },
    cancel() {
      retire();
      setError(null);
    },
    onDownload: async () => {
      const attachment = content();
      if (attachment?.kind !== "attachment" || !attachment.download || request) {
        return;
      }
      const read = attachment.download;
      const currentRequest = { controller: new AbortController() };
      const { connectionEpoch, sessionKey, agentId } = runtime();
      request = currentRequest;
      setError(null);
      const current = () => {
        const scope = runtime();
        return (
          isConnected() &&
          content() === attachment &&
          request === currentRequest &&
          scope.connectionEpoch === connectionEpoch &&
          scope.sessionKey === sessionKey &&
          scope.agentId === agentId &&
          !currentRequest.controller.signal.aborted
        );
      };
      const download = async () => {
        try {
          const blob = await read(currentRequest.controller.signal);
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
          }
        }
      };
      const completion = download();
      return presentation.observe(completion, () => request === currentRequest);
    },
  };
}
