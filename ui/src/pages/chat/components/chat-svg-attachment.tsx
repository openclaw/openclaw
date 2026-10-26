import { Errored, Loading, Show, createMemo, createSignal, onCleanup, onSettled } from "solid-js";
import { registerChatMediaEnglish } from "../../../i18n/locales/en-chat-media.ts";
import { t, registerEnglishCatalog } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import { CompactAttachmentCard } from "./chat-attachment-card-solid.tsx";
import { isCrossOriginHttpSource } from "./chat-attachment-href.ts";
import { observeChatAttachmentViewport } from "./chat-attachment-viewport.ts";
import { readResponseBytesWithinLimit } from "./chat-response-bytes.ts";

registerEnglishCatalog(registerChatMediaEnglish);

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
    const loadKey = createMemo(() => [props.src, props.sourceIdentity, props.sizeBytes] as const, {
      equals: (previous, next) => previous.every((value, index) => Object.is(value, next[index])),
    });
    const renderAttachment = ([src, identity, sizeBytes]: ReturnType<typeof loadKey>) => {
      const [admitted, setAdmitted] = createSignal(false);
      let active = true;
      const current = () =>
        host.isConnected &&
        active &&
        src === host.src &&
        identity === host.sourceIdentity &&
        sizeBytes === host.sizeBytes;

      onSettled(() => {
        let stopObserving: (() => void) | undefined;
        if (src.trim()) {
          // The exported Solid component attaches its host after this nested render settles.
          queueMicrotask(() => {
            if (current()) {
              stopObserving = observeChatAttachmentViewport(host.parentElement ?? host, () => {
                if (current()) {
                  setAdmitted(true);
                }
              });
            }
          });
        }
        return () => {
          active = false;
          stopObserving?.();
        };
      });

      const Fallback = () => {
        onSettled(() => {
          if (current()) {
            host.onMediaLoaded?.();
          }
        });
        return (
          <CompactAttachmentCard
            kind="document"
            label={props.label}
            mimeType={props.mimeType}
            sizeBytes={props.sizeBytes}
            downloadHref={props.downloadHref}
            onExpand={props.onExpand}
          />
        );
      };
      const Preview = () => {
        const bytes = createMemo(async () => {
          // The served Control UI CSP does not admit arbitrary remote image origins.
          if (
            (sizeBytes !== undefined && sizeBytes > SVG_PREVIEW_MAX_BYTES) ||
            isCrossOriginHttpSource(src)
          ) {
            throw new Error("SVG attachment exceeds the preview budget or origin policy");
          }
          const controller = new AbortController();
          const timeout = setTimeout(
            () =>
              controller.abort(new DOMException("SVG attachment fetch timed out", "TimeoutError")),
            SVG_PREVIEW_FETCH_TIMEOUT_MS,
          );
          onCleanup(() => {
            clearTimeout(timeout);
            controller.abort();
          });
          try {
            const response = await fetch(src, {
              credentials: "same-origin",
              headers: { Accept: "image/svg+xml" },
              method: "GET",
              signal: controller.signal,
            });
            if (!response.ok) {
              await response.body?.cancel().catch(() => undefined);
              throw new Error("SVG attachment is unavailable");
            }
            const content = await readResponseBytesWithinLimit(response, SVG_PREVIEW_MAX_BYTES);
            if (!content) {
              throw new Error("SVG attachment exceeds the preview budget");
            }
            return content;
          } finally {
            clearTimeout(timeout);
          }
        });
        const renderImage = (data: ArrayBuffer) => {
          // Object URLs belong to the committed image, never a discardable async result.
          const [result, setResult] = createSignal<SvgRenderSource | Error>();
          const renderSource = createMemo(() => {
            const value = result();
            if (value instanceof Error) {
              throw value;
            }
            return value;
          });
          let source: SvgRenderSource | undefined;
          const retireSource = () => {
            if (source) {
              source.retired = true;
              if (source.retainCount === 0) {
                URL.revokeObjectURL(source.url);
              }
              source = undefined;
            }
          };
          onSettled(() => {
            if (!current()) {
              return undefined;
            }
            source = {
              url: URL.createObjectURL(new Blob([data], { type: "image/svg+xml" })),
              retainCount: 0,
              retired: false,
            };
            setResult(source);
            return retireSource;
          });
          const handleOpen = () => {
            if (!source || !host.onOpen) {
              return;
            }
            const opened = source;
            opened.retainCount += 1;
            let released = false;
            host.onOpen(opened.url, () => {
              if (released) {
                return;
              }
              released = true;
              opened.retainCount -= 1;
              if (opened.retired && opened.retainCount === 0) {
                URL.revokeObjectURL(opened.url);
              }
            });
          };
          return (
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
                        setResult(new Error("SVG attachment could not be decoded"));
                      }
                    }}
                  />
                </button>
              )}
            </Show>
          );
        };
        return (
          <Errored fallback={() => <Fallback />}>
            <Loading>
              <Show when={bytes()} keyed>
                {renderImage}
              </Show>
            </Loading>
          </Errored>
        );
      };
      return (
        <Show when={admitted()}>
          <Preview />
        </Show>
      );
    };
    return (
      <Show when={loadKey()} keyed>
        {renderAttachment}
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
