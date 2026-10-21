import { createMemo, createSignal, onCleanup } from "solid-js";
import { isHttpArtifactDownloadUrl } from "../../../api/artifact-download.ts";
import { fetchControlUiResource } from "../../../app/browser-http.ts";
import { t } from "../../../i18n/index.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { showToast } from "../../../lib/toast.ts";
import { uploadsEnabled } from "../../../lib/uploads.ts";
import { appendChatAttachmentFiles, stagedAttachmentBytes } from "./chat-attachments.ts";
import type { ChatComposerProps } from "./chat-composer-types.ts";
import { readFileDraft } from "./chat-file-drafts.ts";
import { readResponseBytesWithinLimit } from "./chat-response-bytes.ts";
import type { SidebarSelection, AttachmentSidebarRuntime } from "./chat-sidebar-content-types.ts";

export type FileSessionAttachment = {
  disabled: boolean;
  pending: boolean;
  attach: () => void;
};

/** The viewer supplies original downloads; the composer owns admission and draft payloads. */
export function createFileSessionAttachment(props: {
  attachmentChat?: ChatComposerProps;
  content: SidebarSelection | null;
  filePresented?: boolean;
  fileWorkspace?: { showingFolder: boolean } | null;
  attachmentRuntime: AttachmentSidebarRuntime;
}) {
  const active = () => props.filePresented !== false && !props.fileWorkspace?.showingFolder;
  let request: AbortController | null = null;
  const [pending, setPending] = createSignal(false);
  const source = createMemo(() => {
    const content = props.content;
    if (!content) {
      return undefined;
    }
    if (content.kind === "attachment" && !content.file && content.readForAttachment) {
      const read = content.readForAttachment;
      return async (signal: AbortSignal) => {
        const blob = await read(
          props.attachmentRuntime,
          signal,
          props.attachmentChat?.attachmentLimits?.maxBatchBytes ?? Infinity,
        );
        return blob ? { blob, filename: content.title } : null;
      };
    }
    if (content.kind === "markdown" && content.fileDownload) {
      return content.fileDownload.download;
    }
    return content.kind === "file"
      ? content.download
      : content.kind === "image" || content.kind === "attachment" || content.kind === "markdown"
        ? content.file?.download
        : undefined;
  });
  const identity = createMemo(
    () => ({
      source: source(),
      content: props.content,
      key: [props.attachmentChat?.currentAgentId, props.attachmentChat?.sessionKey].join("\0"),
      client: props.attachmentChat?.gatewayClient,
      signal: props.attachmentChat?.readSignal ?? props.attachmentChat?.attachmentReads?.readSignal,
      epoch: props.attachmentRuntime.connectionEpoch,
      policy: props.attachmentRuntime.policyKey,
      auth: props.attachmentRuntime.authToken,
      active: active(),
    }),
    {
      equals: (a, b) =>
        a.source === b.source &&
        a.content === b.content &&
        a.key === b.key &&
        a.client === b.client &&
        a.signal === b.signal &&
        a.epoch === b.epoch &&
        a.policy === b.policy &&
        a.auth === b.auth &&
        a.active === b.active,
    },
  );
  const scope = createMemo(() => {
    const value = identity();
    onCleanup(() => {
      request?.abort();
      request = null;
      setPending(false);
    });
    return value;
  });
  const enabled = () =>
    Boolean(source()) &&
    active() &&
    (props.attachmentChat?.canCompose ?? props.attachmentChat?.canSend) &&
    !props.attachmentChat?.suggestionComposer &&
    uploadsEnabled(props.attachmentChat?.uploadConfig) &&
    Boolean(props.attachmentChat?.onAttachmentsChange);
  const attach = async () => {
    const chat = props.attachmentChat;
    if (!chat || !enabled() || request) {
      return;
    }
    const currentScope = scope();
    const download = currentScope.source;
    if (!download) {
      return;
    }
    const controller = new AbortController();
    request = controller;
    const signal = currentScope.signal
      ? AbortSignal.any([controller.signal, currentScope.signal])
      : controller.signal;
    const current = () => !signal.aborted && scope() === currentScope && enabled();
    const updatePending = chat.onPendingReadsChange;
    let held = true;
    updatePending?.(1);
    const release = () => {
      if (held) {
        held = false;
        updatePending?.(-1);
      }
    };
    const stopAbort = listen(signal, "abort", release, { once: true });
    setPending(true);
    try {
      // The editor owns unsaved text. Clean files use their authorized original bytes,
      // never the possibly truncated or decoded preview.
      const file = currentScope.content;
      const draft = file?.kind === "file" ? readFileDraft(file) : undefined;
      const result =
        file?.kind === "file" && draft
          ? {
              filename: file.name,
              blob: new Blob([draft.content], { type: file.mimeType || "text/plain" }),
            }
          : await download(signal);
      if (!current()) {
        return;
      }
      if (!result) {
        throw new Error(t("chat.attachments.unavailable"));
      }
      let blob: Blob;
      if ("blob" in result) {
        blob = result.blob;
      } else {
        if (!isHttpArtifactDownloadUrl(result.url, props.attachmentRuntime.resourceBasePath)) {
          throw new Error(t("chat.attachments.unavailable"));
        }
        const response = await fetchControlUiResource(result.url, {
          credentials: "same-origin",
          redirect: "error",
          signal,
        });
        if (!response.ok) {
          throw new Error(t("chat.attachments.unavailable"));
        }
        const maxBytes = Math.max(
          0,
          (chat.attachmentLimits?.maxBatchBytes ?? Infinity) - stagedAttachmentBytes(chat),
        );
        const bytes = await readResponseBytesWithinLimit(response, maxBytes);
        if (!current()) {
          return;
        }
        if (!bytes) {
          throw new Error(t("chat.attachments.tooLargeToast"));
        }
        blob = new Blob([bytes], {
          type: response.headers.get("content-type") || "application/octet-stream",
        });
      }
      if (!current()) {
        return;
      }
      appendChatAttachmentFiles([new File([blob], result.filename, { type: blob.type })], chat);
    } catch (error) {
      if (current()) {
        showToast({ message: formatUiError(error), severity: "error" });
      }
    } finally {
      stopAbort();
      release();
      if (request === controller) {
        request = null;
        setPending(false);
      }
    }
  };
  return createMemo<FileSessionAttachment | undefined>(() => {
    scope();
    return source() && props.attachmentChat
      ? { disabled: !enabled() || pending(), pending: pending(), attach: () => void attach() }
      : undefined;
  });
}
