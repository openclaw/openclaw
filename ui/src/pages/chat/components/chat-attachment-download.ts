import { createMemo, createSignal, onCleanup } from "solid-js";
import { t } from "../../../i18n/index.ts";
import { downloadBlobFile } from "../../../lib/download.ts";
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
  const [completion, setCompletion] = createSignal<Promise<void> | undefined>(undefined, {
    ownedWrite: true,
  });
  const outcome = createMemo(() => completion()?.then(() => null) ?? null);
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
    get completion() {
      return completion();
    },
    outcome,
    cancel() {
      retire();
      setCompletion(undefined);
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
            throw cause;
          }
        } finally {
          if (request === currentRequest) {
            request = null;
          }
        }
      };
      const pending = download();
      void setCompletion(pending);
      // The error slot may be retired before it observes this completion.
      void pending.catch(() => {});
      await presentation.observe(pending, () => request === currentRequest).catch(() => {});
    },
  };
}

export type AttachmentDownload = ReturnType<typeof createAttachmentDownload>;
