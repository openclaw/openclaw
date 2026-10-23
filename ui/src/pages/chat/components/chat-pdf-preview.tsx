import {
  type Accessor,
  createMemo,
  createSignal,
  Errored,
  isPending,
  Loading,
  onCleanup,
  onSettled,
  Show,
} from "solid-js";
import { t } from "../../../lib/reactive/i18n.ts";
import { AttachmentPreviewSkeleton, CompactAttachmentCard } from "./chat-attachment-card-solid.tsx";
import { safeAttachmentHref } from "./chat-attachment-href.ts";
import { readResponseBytesWithinLimit } from "./chat-response-bytes.ts";

const PDF_PREVIEW_MAX_BYTES = 16 * 1024 * 1024;
const PDF_PREVIEW_TIMEOUT_MS = 10_000;

export function isPdfAttachment(rawMimeType: string, filename: string): boolean {
  const mimeType = rawMimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    mimeType === "application/pdf" ||
    ((!mimeType || mimeType === "application/octet-stream") && /\.pdf$/i.test(filename))
  );
}

type PdfPreviewProps = {
  src: string;
  sourceIdentity: string;
  label: string;
  mimeType: string;
  sizeBytes?: number;
};

type PdfRead = { ok: true; bytes: ArrayBuffer } | { ok: false; cause: unknown };

/** Owns the bounded, browser-native PDF surface for same-origin attachments. */
export function ChatPdfPreview(props: PdfPreviewProps) {
  // A new ticket keeps its reader; a different attachment or missing source retires it.
  const source = createMemo(
    () =>
      [
        props.sourceIdentity,
        props.sourceIdentity ? undefined : props.src,
        props.sizeBytes,
        Boolean(props.src),
      ] as const,
    { equals: (before, next) => before.every((value, index) => Object.is(value, next[index])) },
  );
  const unavailable = () => (
    <div class="sidebar-attachment-preview__unavailable" role="alert">
      {t("chat.attachments.previewUnavailable")}
      <CompactAttachmentCard
        kind="document"
        label={props.label}
        mimeType={props.mimeType}
        sizeBytes={props.sizeBytes}
        downloadHref={safeAttachmentHref(props.src) ?? undefined}
      />
    </div>
  );
  const renderPreview = (input: ReturnType<typeof source>) => {
    const sizeBytes = input[2];
    if (!input[3]) {
      return <AttachmentPreviewSkeleton />;
    }
    if (sizeBytes !== undefined && sizeBytes > PDF_PREVIEW_MAX_BYTES) {
      return unavailable();
    }
    const result = createMemo<PdfRead>(
      async () => {
        const src = props.src;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), PDF_PREVIEW_TIMEOUT_MS);
        // This cleanup belongs to the tracked read, so replacement aborts transport immediately.
        onCleanup(() => {
          controller.abort();
          clearTimeout(timeout);
        });
        try {
          const response = await fetch(src, {
            credentials: "same-origin",
            redirect: "error",
            signal: controller.signal,
          });
          if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            throw new Error("PDF attachment unavailable");
          }
          const bytes = await readResponseBytesWithinLimit(response, PDF_PREVIEW_MAX_BYTES);
          if (!bytes) {
            throw new Error("PDF attachment exceeds preview limit");
          }
          return { ok: true, bytes };
        } catch (cause) {
          // Commit failure so a later ticket cannot revive the previously successful reader.
          return { ok: false, cause };
        } finally {
          clearTimeout(timeout);
        }
      },
      {
        equals: (before, next) => {
          if (!before.ok || !next.ok || before.bytes.byteLength !== next.bytes.byteLength) {
            return false;
          }
          const right = new Uint8Array(next.bytes);
          return new Uint8Array(before.bytes).every((byte, index) => byte === right[index]);
        },
      },
    );
    const bytes = () => {
      const value = result();
      return value.ok ? value.bytes : undefined;
    };
    const error = () => {
      const value = result();
      if (!value.ok) {
        throw value.cause;
      }
      return null;
    };
    // The reader survives changed bytes; only its settled Blob URL changes lifetime.
    const renderFrame = (value: Accessor<ArrayBuffer>) => {
      const [url, setUrl] = createSignal<string>();
      return (
        <>
          <Show when={value()} keyed>
            {(content) => {
              onSettled(() => {
                const next = URL.createObjectURL(new Blob([content], { type: "application/pdf" }));
                setUrl(next);
                return () => URL.revokeObjectURL(next);
              });
              return null;
            }}
          </Show>
          <Show when={url()}>
            <iframe
              class="sidebar-pdf-preview__frame"
              title={props.label}
              src={url()}
              referrerpolicy="no-referrer"
            />
          </Show>
        </>
      );
    };
    return (
      <Loading fallback={<AttachmentPreviewSkeleton />}>
        <Show
          when={result().ok || !isPending(() => result())}
          fallback={<AttachmentPreviewSkeleton />}
        >
          <Show when={bytes()}>{renderFrame}</Show>
          <Errored fallback={(_error) => unavailable()}>{error()}</Errored>
        </Show>
      </Loading>
    );
  };
  return (
    <openclaw-chat-pdf-preview style={{ display: "contents" }}>
      <div class="sidebar-pdf-preview" aria-label={props.label}>
        <div class="sidebar-pdf-preview__surface">
          <Show when={source()} keyed>
            {renderPreview}
          </Show>
        </div>
      </div>
    </openclaw-chat-pdf-preview>
  );
}
