import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, lazy, Show } from "solid-js";
import type { WidgetPreviewControl } from "../../../../../src/shared/widget-preview-controls.ts";
import { IconButton } from "../../../components/solid/icon-button.tsx";
import { SettingsSegmented } from "../../../components/solid/settings-ui.tsx";
import { registerBrowserEnglish } from "../../../i18n/locales/en-browser.ts";
import { registerChatToolWidgetsEnglish } from "../../../i18n/locales/en-chat-tool-widgets.ts";
import {
  canvasWidgetNameForDocument,
  mcpAppWidgetNameForViewId,
} from "../../../lib/board/provider.ts";
import { isInternalCanvasEntryUrl } from "../../../lib/chat/canvas-embed-policy.ts";
import type { CanvasToolPreview } from "../../../lib/chat/tool-cards.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { showToast } from "../../../lib/toast.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import type { WidgetAnnotationCapture } from "./widget-annotation.tsx";
import { WidgetCardMenu, type WidgetRawDetailsLabel } from "./widget-card-menu.tsx";
import type { WidgetCardOptions, WidgetExportSource } from "./widget-card-view.tsx";
import { captureWidget, exportWidget } from "./widget-export.ts";
import { WidgetPinButton, type WidgetPinTarget } from "./widget-pin-button.tsx";
import { isManagedCanvasDocumentPreview } from "./widget-preview-layout.ts";

registerEnglishCatalog(registerChatToolWidgetsEnglish);
registerEnglishCatalog(registerBrowserEnglish);

const WidgetAnnotation = lazy(() => import("./widget-annotation.tsx"), {
  export: "WidgetAnnotation",
});

export function WidgetCardFrame(props: {
  source: WidgetExportSource;
  controls: WidgetPreviewControl[];
  sandbox: string;
  children: JSX.Element;
  preview: CanvasToolPreview;
  surface: string;
  options?: WidgetCardOptions;
}) {
  const [annotation, setAnnotation] = createSignal<WidgetAnnotationCapture>();
  const [capturing, setCapturing] = createSignal(false);
  let previewElement!: HTMLDivElement;
  let annotationButton: HTMLButtonElement | undefined;
  const exitAnnotation = () => {
    setAnnotation(undefined);
    annotationButton?.focus({ preventScroll: true });
  };
  const provider = () => props.options?.boardProvider;
  const mcpAppViewId = () => props.preview.mcpApp?.viewId?.trim();
  const pinName = () =>
    props.preview.mcpApp
      ? mcpAppViewId()
        ? mcpAppWidgetNameForViewId(mcpAppViewId()!)
        : undefined
      : props.preview.boardWidgetName ||
        (props.preview.viewId?.trim()
          ? canvasWidgetNameForDocument(props.preview.viewId.trim())
          : undefined);
  const canPin = () => {
    const board = provider();
    return (
      props.options?.mediaReadAllowed !== false &&
      board &&
      pinName() &&
      (props.preview.mcpApp
        ? board.canPinMcpApps && mcpAppViewId()
        : board.canPinWidgets &&
          props.sandbox.includes("allow-scripts") &&
          isManagedCanvasDocumentPreview(props.preview))
    );
  };
  const canAnnotate = () =>
    props.options?.mediaReadAllowed !== false &&
    !props.preview.mcpApp &&
    isManagedCanvasDocumentPreview(props.preview) &&
    props.sandbox.includes("allow-scripts");
  const startAnnotation = async () => {
    const source = props.source;
    const frame = source instanceof HTMLIFrameElement ? source : source?.previewFrame;
    if (!frame || capturing()) {
      return;
    }
    const sessionKey = props.options?.sessionKey;
    setCapturing(true);
    try {
      const captured = await captureWidget(frame, true);
      const image = new Image();
      image.src = captured.dataUrl;
      await image.decode();
      const capture = { ...captured, image };
      if (
        previewElement.isConnected &&
        props.source === source &&
        props.options?.sessionKey === sessionKey &&
        canAnnotate()
      ) {
        setAnnotation(capture);
      }
    } catch {
      showToast({ severity: "error", message: t("browser.widgetCaptureFailed") });
    } finally {
      setCapturing(false);
    }
  };
  const canExportImage = () => !props.preview.mcpApp && isInternalCanvasEntryUrl(props.preview.url);
  const hasMenu = () =>
    props.options?.mediaReadAllowed !== false &&
    (canExportImage() || Boolean(props.options?.rawText));
  const pinTarget = createMemo(
    (): WidgetPinTarget | undefined =>
      canPin()
        ? {
            board: provider()!,
            name: pinName()!,
            viewId: mcpAppViewId() || props.preview.viewId!.trim(),
            mcpApp: Boolean(props.preview.mcpApp),
          }
        : undefined,
    {
      equals: (previous, next) =>
        previous?.board === next?.board &&
        previous?.name === next?.name &&
        previous?.viewId === next?.viewId &&
        previous?.mcpApp === next?.mcpApp,
    },
  );
  return (
    <div
      ref={(element) => {
        previewElement = element;
      }}
      class="chat-tool-card__preview"
      data-content-kind={props.preview.mcpApp ? "mcp-app" : "canvas-html"}
      data-kind="canvas"
      data-surface={props.surface}
    >
      <div class="widget-header">
        <h3 class="widget-header__title">
          {props.preview.title?.trim() || t("chat.toolCards.canvas")}
        </h3>
        <div class="chat-tool-card__preview-actions">
          <Show when={canAnnotate()}>
            <IconButton
              icon="penLine"
              label={t("browser.annotateWidget")}
              pressed={Boolean(annotation())}
              busy={capturing()}
              disabled={capturing() || !props.source}
              ref={(element) => {
                annotationButton = element;
              }}
              onClick={() => (annotation() ? exitAnnotation() : void startAnnotation())}
            />
          </Show>
          <Show when={pinTarget()} keyed>
            {(target) => <WidgetPinButton target={target} title={props.preview.title} />}
          </Show>
          <Show when={hasMenu()}>
            <WidgetCardMenu
              canExportImage={canExportImage()}
              hasRawDetails={Boolean(props.options?.rawText)}
              onAction={(value): WidgetRawDetailsLabel | void => {
                const source = props.source;
                const title = props.preview.title;
                const toggleRawDetails = props.options?.toggleRawDetails;
                // Raw details belong to the enclosing tool card; canvas islands own their iframe DOM.
                if (value === "raw-details") {
                  return toggleRawDetails?.()
                    ? "chat.toolCards.hideRawDetails"
                    : "chat.toolCards.showRawDetails";
                }
                const frame = source instanceof HTMLIFrameElement ? source : source?.previewFrame;
                if (!frame) {
                  showToast({ severity: "error", message: t("chat.toolCards.widgetExportFailed") });
                  return;
                }
                const documentHtml =
                  source instanceof HTMLIFrameElement ? undefined : source?.documentHtml;
                void exportWidget(value, frame, title, { documentHtml })
                  .then((result) => {
                    if (result === "rerender-required") {
                      showToast({
                        severity: "error",
                        message: t("chat.toolCards.widgetExportRerender"),
                      });
                    } else if (result === "html") {
                      showToast({
                        severity: undefined,
                        message: t("chat.toolCards.widgetExportHtmlFallback"),
                      });
                    } else if (value === "copy") {
                      showToast({ severity: "success", message: t("common.copied") });
                    }
                  })
                  .catch(() => {
                    showToast({
                      severity: "error",
                      message: t("chat.toolCards.widgetExportFailed"),
                    });
                  });
              }}
            />
          </Show>
        </div>
      </div>
      <Show when={props.controls.length > 0 && canAnnotate()}>
        <div class="widget-header__controls">
          <For each={props.controls} keyed={(control) => control.id}>
            {(control) => (
              <div class="widget-header__control">
                <SettingsSegmented
                  class="settings-segmented--compact"
                  ariaLabel={control().label}
                  value={control().value}
                  options={control().options}
                  disabled={Boolean(annotation()) || capturing()}
                  onChange={(value) => {
                    const source = props.source;
                    if (source && !(source instanceof HTMLIFrameElement)) {
                      source.setPreviewControl(control().id, value);
                    }
                  }}
                />
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={annotation()} keyed>
        {(capture) => (
          <ChatLazyBoundary fallback={<div role="status">{t("common.loading")}</div>}>
            <WidgetAnnotation
              capture={capture}
              title={props.preview.title ?? ""}
              docId={props.preview.viewId ?? ""}
              target={previewElement}
              onExit={exitAnnotation}
            />
          </ChatLazyBoundary>
        )}
      </Show>
      <div class="chat-tool-card__preview-panel" data-side="canvas" hidden={Boolean(annotation())}>
        {props.children}
      </div>
    </div>
  );
}
