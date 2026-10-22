import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  version,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from "pdfjs-dist";
import { createMemo, createSignal, onSettled, Show } from "solid-js";
import { normalizeBasePath } from "../../../app-route-paths.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { createResizeObserver } from "../../../lib/reactive/observers.ts";
import { AttachmentPreviewSkeleton } from "./chat-attachment-card-solid.tsx";
import type { ChatComposerProps } from "./chat-composer-types.ts";
import { offerFileComment } from "./chat-file-comment.ts";
import "../../../styles/chat/pdf-document.css";

registerEnglishCatalog(registerFilePreviewEnglish);

export type PdfDocumentProps = {
  resourceBasePath?: string;
  url: string;
  label: string;
  active?: boolean;
  attachmentChat?: ChatComposerProps;
};

/** One document per accepted byte revision; ticket renewal retains page and zoom. */
export function PdfDocumentView(props: PdfDocumentProps) {
  const [document, setDocument] = createSignal<PDFDocumentProxy | null>(null);
  const [failed, setFailed] = createSignal(false);
  const [page, setPage] = createSignal(1);
  const [zoom, setZoom] = createSignal(1);
  const [width, setWidth] = createSignal(0);
  let scroll!: HTMLDivElement;
  createResizeObserver(
    () => [scroll],
    ([entry]) => {
      if (entry && entry.contentRect.width > 0) {
        setWidth(Math.floor(entry.contentRect.width));
      }
    },
  );
  onSettled(() => {
    const assets = new URL(
      `${normalizeBasePath(props.resourceBasePath ?? "")}/assets/pdfjs-${version}/`,
      window.location.origin,
    ).href;
    // The Gateway serves .js as JavaScript; keep the module worker on that contract.
    GlobalWorkerOptions.workerSrc = `${assets}pdf.worker.min.js`;
    // Only bytes from the bounded preview owner enter the parser. No PDF actions,
    // forms, scripting sandbox, or external document URLs are mounted.
    const loading = getDocument({
      url: props.url,
      cMapUrl: `${assets}cmaps/`,
      standardFontDataUrl: `${assets}standard_fonts/`,
      wasmUrl: `${assets}wasm/`,
      iccUrl: `${assets}iccs/`,
      useWasm: false,
      useSystemFonts: false,
      enableXfa: false,
      stopAtErrors: true,
    });
    let active = true;
    void loading.promise.then(
      (pdf) => {
        if (active) {
          setDocument(pdf);
        }
      },
      () => {
        if (active) {
          setFailed(true);
        }
      },
    );
    return () => {
      active = false;
      void loading.destroy();
    };
  });
  const pageSource = createMemo(() => ({
    pdf: document(),
    page: page(),
    zoom: zoom(),
    width: width(),
  }));
  return (
    <div class="pdf-document">
      <div class="pdf-document__toolbar">
        <button
          type="button"
          class="btn btn--icon btn--sm"
          aria-label={t("filePreview.pdf.previousPage")}
          disabled={!document() || page() <= 1}
          onClick={() => setPage((value) => value - 1)}
        >
          <Icon name="chevronLeft" />
        </button>
        <span role="status">
          {document()
            ? t("filePreview.pdf.pageCount", {
                page: String(page()),
                total: String(document()!.numPages),
              })
            : t("common.loading")}
        </span>
        <button
          type="button"
          class="btn btn--icon btn--sm"
          aria-label={t("filePreview.pdf.nextPage")}
          disabled={!document() || page() >= document()!.numPages}
          onClick={() => setPage((value) => value + 1)}
        >
          <Icon name="chevronRight" />
        </button>
        <button
          type="button"
          class="btn btn--icon btn--sm"
          aria-label={t("filePreview.pdf.zoomOut")}
          disabled={zoom() <= 0.5}
          onClick={() => setZoom((value) => value - 0.25)}
        >
          <span aria-hidden="true">−</span>
        </button>
        <button
          type="button"
          class="btn btn--icon btn--sm"
          aria-label={t("filePreview.pdf.zoomIn")}
          disabled={zoom() >= 2}
          onClick={() => setZoom((value) => value + 0.25)}
        >
          <Icon name="plus" />
        </button>
        <a
          href={props.url}
          target="_blank"
          rel="noreferrer"
          class="btn btn--icon btn--sm"
          aria-label={t("filePreview.pdf.openOriginal")}
          title={t("filePreview.pdf.openOriginal")}
        >
          <Icon name="externalLink" />
        </a>
      </div>
      <div
        class="pdf-document__scroll"
        ref={(element) => {
          scroll = element;
        }}
      >
        <Show
          when={!failed()}
          fallback={
            <div class="callout" role="alert">
              {t("filePreview.pdf.unavailable")}
            </div>
          }
        >
          <Show when={document() && width() > 0} fallback={<AttachmentPreviewSkeleton />}>
            <Show when={pageSource()} keyed>
              {(source) => (
                <PdfPage
                  pdf={source.pdf!}
                  page={source.page}
                  width={source.width}
                  zoom={source.zoom}
                  label={props.label}
                  active={props.active}
                  attachmentChat={props.attachmentChat}
                />
              )}
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  );
}

function PdfPage(props: {
  pdf: PDFDocumentProxy;
  page: number;
  width: number;
  zoom: number;
  label: string;
  active?: boolean;
  attachmentChat?: ChatComposerProps;
}) {
  let canvas!: HTMLCanvasElement;
  let textLayer!: HTMLDivElement;
  let pageElement!: HTMLDivElement;
  const [state, setState] = createSignal<"loading" | "ready" | "empty" | "error">("loading");
  const lifetime = new AbortController();
  onSettled(() => {
    let render: RenderTask | undefined;
    let text: TextLayer | undefined;
    let page: PDFPageProxy | undefined;
    void (async () => {
      page = await props.pdf.getPage(props.page);
      if (lifetime.signal.aborted) {
        return;
      }
      const scale =
        (Math.max(100, props.width - 24) / page.getViewport({ scale: 1 }).width) * props.zoom;
      const viewport = page.getViewport({ scale });
      // Bound backing pixels for large pages; the text layer stays at CSS resolution.
      const ratio = Math.min(
        window.devicePixelRatio || 1,
        2,
        Math.sqrt(8_000_000 / (viewport.width * viewport.height)),
      );
      canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
      canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
      pageElement.style.width = `${viewport.width}px`;
      pageElement.style.height = `${viewport.height}px`;
      pageElement.style.setProperty(
        "--total-scale-factor",
        String(viewport.scale * viewport.userUnit),
      );
      render = page.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      text = new TextLayer({
        textContentSource: page.streamTextContent(),
        container: textLayer,
        viewport,
      });
      await Promise.all([render.promise, text.render()]);
      if (!lifetime.signal.aborted) {
        setState(text.textContentItemsStr.some((value) => value.trim()) ? "ready" : "empty");
      }
    })()
      .catch(() => {
        if (!lifetime.signal.aborted) {
          setState("error");
        }
      })
      .finally(() => {
        if (lifetime.signal.aborted) {
          page?.cleanup();
        }
      });
    return () => {
      lifetime.abort();
      render?.cancel();
      text?.cancel();
      page?.cleanup();
    };
  });
  const comment = () => {
    const selection = window.getSelection();
    if (state() !== "ready" || !selection || selection.isCollapsed || selection.rangeCount !== 1) {
      return;
    }
    const range = selection.getRangeAt(0);
    if (!textLayer.contains(range.startContainer) || !textLayer.contains(range.endContainer)) {
      return;
    }
    const text = selection.toString();
    if (!text.trim()) {
      return;
    }
    const prefix = range.cloneRange();
    prefix.selectNodeContents(textLayer);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = prefix.toString().length;
    prefix.setEnd(range.endContainer, range.endOffset);
    const chat = props.attachmentChat;
    offerFileComment({
      readChat: () => props.attachmentChat,
      selection: {
        text,
        start,
        end: prefix.toString().length,
        pdf: { name: props.label, page: props.page },
      },
      range: range.cloneRange(),
      signal: chat?.readSignal
        ? AbortSignal.any([lifetime.signal, chat.readSignal])
        : lifetime.signal,
      isCurrent: () => props.active !== false && textLayer.isConnected,
    });
  };
  return (
    <div class="pdf-document__page-container">
      <Show when={state() === "loading"}>
        <AttachmentPreviewSkeleton />
      </Show>
      <Show when={state() === "error"}>
        <div class="callout" role="alert">
          {t("filePreview.pdf.unavailable")}
        </div>
      </Show>
      <div
        class="pdf-document__page"
        style={{ visibility: state() === "loading" ? "hidden" : "visible" }}
        aria-busy={state() === "loading" ? "true" : "false"}
        ref={(element) => {
          pageElement = element;
        }}
        aria-label={t("filePreview.pdf.page", { page: String(props.page) })}
        hidden={state() === "error"}
      >
        <canvas
          ref={(element) => {
            canvas = element;
          }}
          aria-hidden="true"
        />
        <div
          class="textLayer"
          ref={(element) => {
            textLayer = element;
          }}
          onPointerUp={comment}
          onKeyUp={(event) => {
            if (event.shiftKey && event.key.startsWith("Arrow")) {
              comment();
            }
          }}
          tabindex={0}
        />
      </div>
      <Show when={state() === "empty"}>
        <p class="pdf-document__notice">{t("filePreview.pdf.noText")}</p>
      </Show>
    </div>
  );
}
