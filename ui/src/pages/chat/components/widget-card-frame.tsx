import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import type { WidgetPreviewControl } from "../../../../../src/shared/widget-preview-controls.ts";
import { widgetInspectionAnchor } from "../../../components/canvas-widget-inspection.ts";
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
import { listen } from "../../../lib/reactive/listener.ts";
import { showToast } from "../../../lib/toast.ts";
import { WidgetCardMenu, type WidgetRawDetailsLabel } from "./widget-card-menu.tsx";
import type { WidgetCardOptions, WidgetExportSource } from "./widget-card.types.ts";
import { WIDGET_COMMENT_INTENT, type WidgetCommentIntent } from "./widget-comment-intent.ts";
import { exportWidget } from "./widget-export.ts";
import { WidgetPinButton, type WidgetPinTarget } from "./widget-pin-button.tsx";
import { isManagedCanvasDocumentPreview } from "./widget-preview-layout.ts";

registerEnglishCatalog(registerChatToolWidgetsEnglish);
registerEnglishCatalog(registerBrowserEnglish);

export function WidgetCardFrame(props: {
  source: WidgetExportSource;
  controls: WidgetPreviewControl[];
  sandbox: string;
  children: JSX.Element;
  preview: CanvasToolPreview;
  surface: string;
  options?: WidgetCardOptions;
}) {
  const [inspecting, setInspecting] = createSignal(false);
  const [outline, setOutline] = createSignal<DOMRect>();
  let panel!: HTMLDivElement;
  let previewElement!: HTMLDivElement;
  let annotationButton: HTMLButtonElement | undefined;
  let stopInspection: (() => void) | undefined;
  let editor: AbortController | undefined;
  const focusPen = () => annotationButton?.focus({ preventScroll: true });
  onSettled(() => () => {
    stopInspection?.();
    editor?.abort();
  });
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
  const toggleAnnotation = () => {
    if (stopInspection) {
      stopInspection();
      return;
    }
    const source = props.source;
    if (!source || source instanceof HTMLIFrameElement) {
      return;
    }
    editor?.abort();
    const listeners = new AbortController();
    const stop = source.startInspection((event) => {
      if (event.kind === "cancel") {
        listeners.abort();
        stopInspection = undefined;
        setInspecting(false);
        setOutline(undefined);
        if (document.activeElement === source.previewFrame) {
          focusPen();
        }
        return;
      }
      if (event.kind === "hover") {
        const frame = source.previewFrame;
        const rect = event.rect;
        if (frame && rect) {
          const box = widgetInspectionAnchor(frame, rect);
          const panelBox = panel.getBoundingClientRect();
          const scaleX = panelBox.width / panel.offsetWidth || 1;
          const scaleY = panelBox.height / panel.offsetHeight || 1;
          setOutline(
            new DOMRect(
              (box.left - panelBox.left) / scaleX,
              (box.top - panelBox.top) / scaleY,
              box.width / scaleX,
              box.height / scaleY,
            ),
          );
        } else {
          setOutline(undefined);
        }
        return;
      }
      const anchor = widgetInspectionAnchor(event.frame, event.rect);
      stopInspection?.();
      const owner = new AbortController();
      editor = owner;
      const detail: WidgetCommentIntent = {
        text: `${props.preview.title?.trim() || t("chat.toolCards.canvas")} — ${event.label}`,
        anchor,
        signal: owner.signal,
        current: () =>
          previewElement.isConnected &&
          source.presentationActive &&
          props.source === source &&
          source.previewFrame === event.frame &&
          canAnnotate(),
        onCancel: focusPen,
      };
      if (
        previewElement.dispatchEvent(
          new CustomEvent(WIDGET_COMMENT_INTENT, { detail, bubbles: true, cancelable: true }),
        )
      ) {
        owner.abort();
        focusPen();
      }
    });
    if (!stop) {
      showToast({ severity: "error", message: t("browser.widgetInspectUnavailable") });
      return;
    }
    stopInspection = stop;
    setInspecting(true);
    listen(
      document,
      "pointerdown",
      (event) => {
        if (
          event.target !== annotationButton &&
          !annotationButton?.contains(event.target as Node)
        ) {
          stop();
        }
      },
      { capture: true, signal: listeners.signal },
    );
    listen(
      document,
      "keydown",
      (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          stop();
          focusPen();
        }
      },
      { signal: listeners.signal },
    );
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
              pressed={inspecting()}
              disabled={!props.source || props.source instanceof HTMLIFrameElement}
              ref={(element) => {
                annotationButton = element;
              }}
              onClick={toggleAnnotation}
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
      <div
        class="chat-tool-card__preview-panel"
        data-side="canvas"
        ref={(node) => {
          panel = node;
        }}
      >
        {props.children}
        <Show when={outline()}>
          {(rect) => (
            <div
              class="widget-inspect-outline"
              aria-hidden="true"
              style={{
                left: `${rect().left}px`,
                top: `${rect().top}px`,
                width: `${rect().width}px`,
                height: `${rect().height}px`,
              }}
            />
          )}
        </Show>
      </div>
    </div>
  );
}
