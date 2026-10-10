import { Show, createEffect, createMemo, createSignal, onCleanup, runWithOwner } from "solid-js";
import { t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lit/solid-bridge.ts";
import { CompactAttachmentCard } from "./chat-attachment-card-solid.tsx";
import { isCrossOriginHttpSource } from "./chat-attachment-href.ts";
import { observeChatAttachmentViewport } from "./chat-attachment-viewport.ts";
import { readResponseBytesWithinLimit } from "./chat-response-bytes.ts";

const SVG_PREVIEW_MAX_BYTES = 256 * 1024;
const SVG_PREVIEW_FETCH_TIMEOUT_MS = 10_000;

type SvgRenderSource = {
  url: string;
  retainCount: number;
  retired: boolean;
};

type SvgAttachmentProps = {
  src: string;
  sourceIdentity: string;
  label: string;
  mimeType: string;
  sizeBytes: number | undefined;
  downloadHref: string;
  onOpen: ((src: string, release: () => void) => void) | undefined;
  onExpand: (() => void) | undefined;
  onMediaLoaded: (() => void) | undefined;
};

type ChatSvgAttachmentElement = SolidBridgeElement<SvgAttachmentProps>;

export const ChatSvgAttachment = defineSolidBridge<SvgAttachmentProps>(
  "openclaw-chat-svg-attachment",
  (props, host) => {
    const [renderSource, setRenderSource] = createSignal<SvgRenderSource>();
    const [failed, setFailed] = createSignal(false);
    let source: SvgRenderSource | undefined;
    let loadVersion = 0;
    let abortController: AbortController | undefined;

    const retireSource = () => {
      if (source) {
        source.retired = true;
        if (source.retainCount === 0) {
          URL.revokeObjectURL(source.url);
        }
        source = undefined;
        setRenderSource(undefined);
      }
    };
    const releaseSource = () =>
      runWithOwner(null, () => {
        loadVersion += 1;
        abortController?.abort();
        abortController = undefined;
        retireSource();
      });
    const showFallback = () => {
      setFailed(true);
      host.onMediaLoaded?.();
    };

    const loadKey = createMemo(() => [props.src, props.sourceIdentity, props.sizeBytes] as const, {
      equals: (previous, next) => previous.every((value, index) => Object.is(value, next[index])),
    });
    createEffect(loadKey, ([src, identity, sizeBytes]) =>
      runWithOwner(null, () => {
        releaseSource();
        setFailed(false);
        const version = loadVersion;
        const current = () =>
          host.isConnected &&
          version === loadVersion &&
          src === host.src &&
          identity === host.sourceIdentity &&
          sizeBytes === host.sizeBytes;
        const loadSource = async () => {
          if (!current()) {
            return;
          }
          // The served Control UI CSP does not admit arbitrary remote image origins.
          if (
            (sizeBytes !== undefined && sizeBytes > SVG_PREVIEW_MAX_BYTES) ||
            isCrossOriginHttpSource(src)
          ) {
            showFallback();
            return;
          }
          const controller = new AbortController();
          abortController = controller;
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            const response = await Promise.race([
              fetch(src, {
                credentials: "same-origin",
                headers: { Accept: "image/svg+xml" },
                method: "GET",
                signal: controller.signal,
              }),
              new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(() => {
                  controller.abort();
                  reject(new DOMException("SVG attachment fetch timed out", "TimeoutError"));
                }, SVG_PREVIEW_FETCH_TIMEOUT_MS);
              }),
            ]);
            if (!response.ok) {
              await response.body?.cancel().catch(() => undefined);
              throw new Error("SVG attachment is unavailable");
            }
            const bytes = await readResponseBytesWithinLimit(response, SVG_PREVIEW_MAX_BYTES);
            if (!bytes) {
              throw new Error("SVG attachment exceeds the preview budget");
            }
            const url = URL.createObjectURL(new Blob([bytes], { type: "image/svg+xml" }));
            if (!current()) {
              URL.revokeObjectURL(url);
              return;
            }
            source = { url, retainCount: 0, retired: false };
            setRenderSource(source);
          } catch {
            if (current()) {
              showFallback();
            }
          } finally {
            clearTimeout(timeout);
            if (abortController === controller) {
              abortController = undefined;
            }
          }
        };
        let stopObserving: (() => void) | undefined;
        if (src.trim()) {
          // The exported Solid component attaches its host after this nested render settles.
          queueMicrotask(() => {
            if (current()) {
              stopObserving = observeChatAttachmentViewport(
                host.parentElement ?? host,
                () => void loadSource(),
              );
            }
          });
        }
        return () => {
          stopObserving?.();
          releaseSource();
        };
      }),
    );
    onCleanup(releaseSource);

    const handleOpen = () => {
      if (!source || !host.onOpen) {
        return;
      }
      const opened = source;
      opened.retainCount += 1;
      let released = false;
      const release = () => {
        if (released) {
          return;
        }
        released = true;
        opened.retainCount -= 1;
        if (opened.retired && opened.retainCount === 0) {
          URL.revokeObjectURL(opened.url);
        }
      };
      try {
        host.onOpen(opened.url, release);
      } catch (error) {
        release();
        throw error;
      }
    };

    return (
      <Show
        when={!failed()}
        fallback={
          <CompactAttachmentCard
            kind="document"
            label={props.label}
            mimeType={props.mimeType}
            sizeBytes={props.sizeBytes}
            downloadHref={props.downloadHref}
            onExpand={props.onExpand}
          />
        }
      >
        <Show when={renderSource()} keyed>
          {(image) => (
            <button
              type="button"
              class="chat-message-image-button"
              aria-label={t("chat.imageLightbox.open", { title: props.label })}
              onClick={handleOpen}
            >
              <img
                src={image.url}
                alt={props.label}
                class="chat-message-image"
                onLoad={() => props.onMediaLoaded?.()}
                onError={() => {
                  if (source === image) {
                    retireSource();
                    showFallback();
                  }
                }}
              />
            </button>
          )}
        </Show>
      </Show>
    );
  },
  {
    properties: {
      src: { default: "" },
      sourceIdentity: { default: "" },
      label: { default: "" },
      mimeType: { default: "image/svg+xml" },
      sizeBytes: { default: undefined, type: Number },
      downloadHref: { default: "" },
      onOpen: { default: undefined, attribute: false },
      onExpand: { default: undefined, attribute: false },
      onMediaLoaded: { default: undefined, attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-svg-attachment": ChatSvgAttachmentElement;
  }
}
