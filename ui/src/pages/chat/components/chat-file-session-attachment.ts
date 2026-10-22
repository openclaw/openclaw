import { action, createMemo, createOptimistic, onCleanup } from "solid-js";
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

export type FileSessionAttachmentProps = {
  attachmentChat?: ChatComposerProps;
  content: SidebarSelection | null;
  filePresented?: boolean;
  fileWorkspace?: { showingFolder: boolean } | null;
  attachmentRuntime: AttachmentSidebarRuntime;
};

/** The viewer supplies original downloads; the composer owns admission and draft payloads. */
export function createFileSessionAttachment(props: FileSessionAttachmentProps) {
  type AttachmentRequest = {
    controller: AbortController;
    identity: ReturnType<typeof readIdentity>;
    retired: ReturnType<typeof Promise.withResolvers<void>>;
  };
  let request: AttachmentRequest | null = null;
  const [pending, setPending] = createOptimistic<AttachmentRequest | null>(null);
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
  const readIdentity = (value: FileSessionAttachmentProps) => ({
    content: value.content,
    source:
      value.content?.kind === "attachment" && !value.content.file
        ? value.content.readForAttachment
        : value.content?.kind === "file"
          ? value.content.download
          : value.content?.kind === "markdown" && value.content.fileDownload
            ? value.content.fileDownload.download
            : value.content?.kind === "image" ||
                value.content?.kind === "attachment" ||
                value.content?.kind === "markdown"
              ? value.content.file?.download
              : undefined,
    key: [value.attachmentChat?.currentAgentId, value.attachmentChat?.sessionKey].join("\0"),
    client: value.attachmentChat?.gatewayClient,
    signal: value.attachmentChat?.readSignal ?? value.attachmentChat?.attachmentReads?.readSignal,
    reads: value.attachmentChat?.attachmentReads,
    getAttachments: value.attachmentChat?.getAttachments,
    onAttachmentsChange: value.attachmentChat?.onAttachmentsChange,
    onPendingReadsChange: value.attachmentChat?.onPendingReadsChange,
    epoch: value.attachmentRuntime.connectionEpoch,
    runtimeAgent: value.attachmentRuntime.agentId,
    runtimeSession: value.attachmentRuntime.sessionKey,
    resourceBasePath: value.attachmentRuntime.resourceBasePath,
    resolveArtifactDownload: value.attachmentRuntime.resolveArtifactDownload,
    policy: value.attachmentRuntime.policyKey,
    auth: value.attachmentRuntime.authToken,
    active: value.filePresented !== false && !value.fileWorkspace?.showingFolder,
  });
  const sameIdentity = (a: ReturnType<typeof readIdentity>, b: ReturnType<typeof readIdentity>) =>
    a.content === b.content &&
    a.source === b.source &&
    a.key === b.key &&
    a.client === b.client &&
    a.signal === b.signal &&
    a.reads === b.reads &&
    a.getAttachments === b.getAttachments &&
    a.onAttachmentsChange === b.onAttachmentsChange &&
    a.onPendingReadsChange === b.onPendingReadsChange &&
    a.epoch === b.epoch &&
    a.runtimeAgent === b.runtimeAgent &&
    a.runtimeSession === b.runtimeSession &&
    a.resourceBasePath === b.resourceBasePath &&
    a.resolveArtifactDownload === b.resolveArtifactDownload &&
    a.policy === b.policy &&
    a.auth === b.auth &&
    a.active === b.active;
  const enabled = (value: FileSessionAttachmentProps = props) =>
    value.filePresented !== false &&
    !value.fileWorkspace?.showingFolder &&
    (value.attachmentChat?.canCompose ?? value.attachmentChat?.canSend) &&
    !value.attachmentChat?.suggestionComposer &&
    uploadsEnabled(value.attachmentChat?.uploadConfig) &&
    Boolean(value.attachmentChat?.onAttachmentsChange);
  // Native property callbacks supply raw next props before Solid publishes the new frame.
  const retire = (next?: FileSessionAttachmentProps) => {
    if (!request || (next && sameIdentity(request.identity, readIdentity(next)) && enabled(next))) {
      return;
    }
    const retired = request;
    request = null;
    retired.controller.abort();
    retired.retired.resolve();
  };
  const identity = createMemo(() => readIdentity(props), { equals: sameIdentity });
  const scope = createMemo(() => {
    const value = identity();
    onCleanup(() => retire());
    return value;
  });
  const present = action(function* (completion: Promise<void>, admitted: AttachmentRequest) {
    if (request === admitted) {
      setPending(admitted);
    }
    yield Promise.race([completion, admitted.retired.promise]);
  });
  const attach = async () => {
    const chat = props.attachmentChat;
    if (!chat || !enabled() || request) {
      return;
    }
    const currentScope = scope();
    const download = source();
    if (!download || currentScope.signal?.aborted) {
      return;
    }
    const controller = new AbortController();
    const admitted = { controller, identity: currentScope, retired: Promise.withResolvers<void>() };
    request = admitted;
    const signal = currentScope.signal
      ? AbortSignal.any([controller.signal, currentScope.signal])
      : controller.signal;
    const current = () =>
      !signal.aborted &&
      request === admitted &&
      sameIdentity(currentScope, readIdentity(props)) &&
      enabled();
    const updatePending = chat.onPendingReadsChange;
    let held = true;
    updatePending?.(1);
    const release = () => {
      if (held) {
        held = false;
        updatePending?.(-1);
      }
    };
    const stopAbort = listen(
      signal,
      "abort",
      () => {
        release();
        admitted.retired.resolve();
        if (request === admitted) {
          request = null;
        }
      },
      { once: true },
    );
    const completion = (async () => {
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
        if (request === admitted) {
          request = null;
        }
      }
    })();
    await Promise.resolve();
    await present(completion, admitted);
  };
  const read = createMemo<FileSessionAttachment | undefined>(() => {
    const currentScope = scope();
    return source() && props.attachmentChat
      ? {
          get disabled() {
            return (pending() === request && request?.identity === currentScope) || !enabled();
          },
          get pending() {
            return pending() === request && request?.identity === currentScope;
          },
          attach: () => void attach(),
        }
      : undefined;
  });
  return Object.assign(read, { retire });
}
