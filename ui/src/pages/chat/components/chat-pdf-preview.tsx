import { createMemo, createSignal, onSettled, Show } from "solid-js";
import { t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
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

/** Owns the bounded, browser-native PDF surface for same-origin attachments. */
function PdfPreview(props: PdfPreviewProps) {
  const [preview, setPreview] = createSignal<{
    status: "loading" | "ready" | "error";
    url?: string;
  }>({ status: "loading" });
  let previewUrl: string | undefined;
  let previewBytes: Uint8Array | undefined;
  let previous: { sourceIdentity: string; sizeBytes?: number } | undefined;
  let active: AbortController | undefined;
  const revokePreview = () => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }
    previewUrl = undefined;
    previewBytes = undefined;
  };
  const source = createMemo(
    () => ({ src: props.src, sourceIdentity: props.sourceIdentity, sizeBytes: props.sizeBytes }),
    {
      equals: (before, next) =>
        before.src === next.src &&
        before.sourceIdentity === next.sourceIdentity &&
        before.sizeBytes === next.sizeBytes,
    },
  );
  const readPreview = (value: ReturnType<typeof source>) => {
    onSettled(() => {
      // A renewed ticket for the same attachment must not reset the native reader.
      if (
        !value.src ||
        !previewUrl ||
        !value.sourceIdentity ||
        previous?.sourceIdentity !== value.sourceIdentity ||
        previous?.sizeBytes !== value.sizeBytes
      ) {
        revokePreview();
        setPreview({ status: "loading" });
      }
      previous = value;
      if (!value.src) {
        return undefined;
      }
      if (value.sizeBytes !== undefined && value.sizeBytes > PDF_PREVIEW_MAX_BYTES) {
        revokePreview();
        setPreview({ status: "error" });
        return undefined;
      }
      const controller = new AbortController();
      active = controller;
      const timeout = setTimeout(() => controller.abort(), PDF_PREVIEW_TIMEOUT_MS);
      void (async () => {
        try {
          const response = await fetch(value.src, {
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
          if (active !== controller) {
            return;
          }
          const nextBytes = new Uint8Array(bytes);
          if (
            previewBytes?.length === nextBytes.length &&
            previewBytes.every((byte, index) => byte === nextBytes[index])
          ) {
            return;
          }
          revokePreview();
          previewBytes = nextBytes;
          previewUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
          setPreview({ status: "ready", url: previewUrl });
        } catch {
          if (active === controller) {
            revokePreview();
            setPreview({ status: "error" });
          }
        } finally {
          clearTimeout(timeout);
          if (active === controller) {
            active = undefined;
          }
        }
      })();
      return () => {
        if (active === controller) {
          active = undefined;
        }
        controller.abort();
        clearTimeout(timeout);
      };
    });
    return null;
  };
  onSettled(() => revokePreview);
  return (
    <div class="sidebar-pdf-preview" aria-label={props.label}>
      <Show when={source()} keyed>
        {readPreview}
      </Show>
      <div class="sidebar-pdf-preview__surface">
        <Show when={preview().status !== "loading"} fallback={<AttachmentPreviewSkeleton />}>
          <Show
            when={preview().status === "ready" && preview().url}
            fallback={
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
            }
          >
            <iframe
              class="sidebar-pdf-preview__frame"
              title={props.label}
              src={preview().url}
              referrerpolicy="no-referrer"
            />
          </Show>
        </Show>
      </div>
    </div>
  );
}

export const ChatPdfPreview = defineSolidBridge<PdfPreviewProps>(
  "openclaw-chat-pdf-preview",
  (props, host) => {
    host.style.display = "contents";
    return <PdfPreview {...props} />;
  },
  {
    properties: {
      src: { default: "" },
      sourceIdentity: { default: "" },
      label: { default: "" },
      mimeType: { default: "" },
      sizeBytes: { default: undefined, type: Number },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-pdf-preview": SolidBridgeElement<PdfPreviewProps>;
  }
}
