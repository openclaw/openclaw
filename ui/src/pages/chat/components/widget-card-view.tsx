import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createMemo,
  createSignal,
  Errored,
  lazy,
  Loading,
  onSettled,
  Show,
  untrack,
  useContext,
} from "solid-js";
import { ensureCustomElementDefined } from "../../../app/lazy-custom-element.ts";
import type { OpenClawCanvasWidgetView } from "../../../components/canvas-widget-view.tsx";
import { dispatchWidgetPrompt } from "../../../components/mcp-app-security.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { LazyViewError } from "../../../components/solid/lazy-view-error.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerMcpAppEnglish } from "../../../i18n/locales/en-mcp-app.ts";
import {
  canvasWidgetNameForDocument,
  mcpAppWidgetNameForViewId,
  type BoardProvider,
} from "../../../lib/board/provider.ts";
import { createCanvasFramePresentation } from "../../../lib/chat/canvas-frame-presentation.ts";
import { getCanvasWidgetFrameConnectionGeneration } from "../../../lib/chat/canvas-widget-frame-generation.ts";
import type {
  CanvasToolPreview,
  ToolPreview as ToolPreviewModel,
} from "../../../lib/chat/tool-cards.ts";
import {
  isInternalCanvasEntryUrl,
  resolveCanvasIframeUrl,
  resolveEmbedSandbox,
  type EmbedSandboxMode,
} from "../../../lib/chat/tool-display.ts";
import { parseYouTubeVideoUrl } from "../../../lib/chat/youtube-video.ts";
import { cancelLayout, scheduleLayout } from "../../../lib/layout-frame.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { createResizeObserver } from "../../../lib/reactive/observers.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { showToast } from "../../../lib/toast.ts";
import { postWidgetTheme, registerWidgetThemeFrame } from "../../../lib/widget-theme.ts";
import { BrowserTabCardHost } from "./browser-tab-card.tsx";
import { CanvasWidgetMount } from "./canvas-widget-mount.tsx";
import {
  WidgetCardMenu,
  type WidgetAction,
  type WidgetRawDetailsLabel,
} from "./widget-card-menu.tsx";
import { exportWidget } from "./widget-export.ts";
import { WidgetPinButton, type WidgetPinTarget } from "./widget-pin-button.tsx";

registerEnglishCatalog(registerChatSessionEnglish);

registerMcpAppEnglish();

const YouTubeVideoCard = lazy(() => import("./youtube-video-card.tsx"), {
  export: "YouTubeVideoCard",
});

type WidgetCardOptions = {
  rawText?: string | null;
  toggleRawDetails?: () => boolean;
  canvasPluginSurfaceUrl?: string | null;
  embedSandboxMode?: EmbedSandboxMode;
  allowExternalEmbedUrls?: boolean;
  sessionKey?: string;
  messageTimestamp?: number;
  boardProvider?: BoardProvider;
  widgetLayout?: import("../session-message-cache.ts").ChatWidgetLayout;
};

type WidgetExportSource = HTMLIFrameElement | OpenClawCanvasWidgetView | undefined;

function isManagedCanvasDocumentPreview(preview: CanvasToolPreview): boolean {
  const viewId = preview.viewId?.trim();
  const entryUrl = preview.url?.trim();
  if (!viewId || !entryUrl) {
    return false;
  }
  try {
    const entry = new URL(entryUrl, "http://localhost");
    const prefix = "/__openclaw__/canvas/documents/";
    if (entry.origin !== "http://localhost" || !entry.pathname.startsWith(prefix)) {
      return false;
    }
    const [encodedDocumentId, entrypoint] = entry.pathname.slice(prefix.length).split("/", 2);
    if (!encodedDocumentId || !entrypoint) {
      return false;
    }
    const documentId = decodeURIComponent(encodedDocumentId);
    return /^[A-Za-z0-9._-]+$/u.test(documentId) && documentId === viewId;
  } catch {
    return false;
  }
}

// Sandboxed widget documents report their content height via postMessage so the
// preview iframe can fit short/tall widgets. The event source must be one of our
// preview frames and the height is clamped, so widget code can only resize its
// own frame within the same bounds the preview contract allows.
const WIDGET_SIZE_MESSAGE_TYPE = "openclaw:widget-size";
const WIDGET_PROMPT_OFFER_MESSAGE_TYPE = "openclaw:widget-prompt-offer";
const WIDGET_PROMPT_MESSAGE_TYPE = "openclaw:widget-prompt";
const WIDGET_PROMPT_HOST_READY_MESSAGE_TYPE = "openclaw:widget-prompt-host-ready";
const WIDGET_CHAT_HOST_MESSAGE_TYPE = "openclaw:widget-chat-host";
const WIDGET_FRAME_MIN_HEIGHT = 48;
// The ceiling is an abuse bound, not a layout preference: a widget that reports
// a runaway size cannot blow up the transcript, but ordinary tall widgets must
// fit their content here — a frame shorter than its document scrolls inside the
// row, which hides content behind a nested scrollbar the transcript cannot see.
const WIDGET_FRAME_MAX_HEIGHT = 8000;
// Frames register on load so messages can be matched to their owning preview.
const widgetFrameRegistry = new Set<HTMLIFrameElement>();
const widgetFrameResize = new WeakMap<HTMLIFrameElement, (height: number) => void>();
const widgetFramePromptActive = new WeakMap<HTMLIFrameElement, () => boolean>();
const loadedWidgetFrames = new WeakSet<HTMLIFrameElement>();
// Keyed by window, not a module boolean: non-isolated test workers swap the
// global window between files while module state persists.
const widgetSizeListenerWindows = new WeakSet<Window>();

function handleWidgetPromptMessage(frame: HTMLIFrameElement, data: unknown) {
  if (
    !isRecord(data) ||
    data.type !== WIDGET_PROMPT_MESSAGE_TYPE ||
    !widgetFramePromptActive.get(frame)?.()
  ) {
    return;
  }
  void dispatchWidgetPrompt(frame, data.prompt, frame.getAttribute("src") ?? "");
}

// Prompt authority is a MessagePort OFFERED by the trusted bridge script that
// wraps every hosted widget document. The bridge posts its offer at document
// parse time — before any widget code can run, steal the endpoint, or navigate
// the frame — so buffering only the FIRST offer per content window and adopting
// it once, at the frame's first load, binds the capability to the genuine
// widget document. A document that navigates away closes its ports with it,
// externally allowed embed URLs are never adopted, and later offers or loads
// cannot re-arm a consumed frame.
const pendingWidgetPromptPorts = new WeakMap<object, MessagePort>();
const offeredWidgetPromptSources = new WeakSet<object>();
const promptEligibleFrames = new WeakSet<HTMLIFrameElement>();
const adoptedWidgetPromptFrames = new WeakSet<HTMLIFrameElement>();
// Keyed by window, not a module boolean: non-isolated test workers swap the
// global window between files while module state persists.
const widgetPromptOfferListenerWindows = new WeakSet<Window>();

function tryAdoptWidgetPromptPort(frame: HTMLIFrameElement) {
  const source = frame.contentWindow;
  if (adoptedWidgetPromptFrames.has(frame) || !promptEligibleFrames.has(frame) || !source) {
    return;
  }
  const port = pendingWidgetPromptPorts.get(source);
  if (!port) {
    return;
  }
  adoptedWidgetPromptFrames.add(frame);
  pendingWidgetPromptPorts.delete(source);
  listen(port, "message", (message) => {
    handleWidgetPromptMessage(frame, message.data);
  });
  port.start();
  // The wrapper waits for this trusted adoption signal before using the
  // legacy inline channel, so board widgets can wait for their view ticket.
  port.postMessage({ type: WIDGET_PROMPT_HOST_READY_MESSAGE_TYPE });
}

function installWidgetPromptOfferListener() {
  if (typeof window === "undefined" || widgetPromptOfferListenerWindows.has(window)) {
    return;
  }
  widgetPromptOfferListenerWindows.add(window);
  // Window-lifetime transport: offers can arrive before any preview frame mounts.
  listen(window, "message", (event) => {
    const data: unknown = event.data;
    if (!isRecord(data) || data.type !== WIDGET_PROMPT_OFFER_MESSAGE_TYPE) {
      return;
    }
    const source = event.source;
    const port = event.ports[0];
    // Hosted widget documents run in an opaque origin; anything else is not a
    // Canvas widget bridge.
    if (!source || !port || event.origin !== "null") {
      return;
    }
    if (offeredWidgetPromptSources.has(source)) {
      // Only the first offer per content window can win; a replacement
      // document's offer must never displace the genuine bridge's.
      port.close();
      return;
    }
    offeredWidgetPromptSources.add(source);
    pendingWidgetPromptPorts.set(source, port);
    // Posted-message and iframe-load tasks have no guaranteed cross-source
    // ordering, so the offer may arrive after the eligible frame's load;
    // adopt for it now instead of stranding the widget without a channel.
    for (const frame of widgetFrameRegistry) {
      if (frame.contentWindow === source) {
        tryAdoptWidgetPromptPort(frame);
        return;
      }
    }
  });
}

function installWidgetSizeListener() {
  if (typeof window === "undefined" || widgetSizeListenerWindows.has(window)) {
    return;
  }
  widgetSizeListenerWindows.add(window);
  // Window-lifetime transport shared by the registered iframe islands.
  listen(window, "message", (event) => {
    const data: unknown = event.data;
    if (
      !isRecord(data) ||
      data.type !== WIDGET_SIZE_MESSAGE_TYPE ||
      typeof data.height !== "number" ||
      !Number.isFinite(data.height)
    ) {
      return;
    }
    for (const frame of widgetFrameRegistry) {
      if (!frame.isConnected) {
        widgetFrameRegistry.delete(frame);
        continue;
      }
      if (frame.contentWindow === event.source) {
        const height = Math.min(
          Math.max(Math.trunc(data.height), WIDGET_FRAME_MIN_HEIGHT),
          WIDGET_FRAME_MAX_HEIGHT,
        );
        // The stylesheet floors the frame at min-height 420px; reported sizes
        // must override both properties to fit short widgets.
        frame.style.height = `${height}px`;
        frame.style.minHeight = `${height}px`;
        widgetFrameResize.get(frame)?.(height);
        return;
      }
    }
  });
}

type PreviewFrameParams = {
  title: string;
  src?: string;
  frameKey?: string;
  height?: number;
  onHeightChange?: (height: number) => void;
  sandbox?: string;
  promptCapable?: boolean;
};

function WidgetFrame(props: {
  params: PreviewFrameParams;
  promptAllowed: () => boolean;
  onFrame: (frame: HTMLIFrameElement | undefined) => void;
}) {
  let frame: HTMLIFrameElement | undefined;
  const [reportedHeight, setReportedHeight] = createSignal<number>();
  // Prompt policy is fixed by the outer URL/sandbox identity.
  const initialPromptCapable = untrack(() => props.params.promptCapable);
  installWidgetSizeListener();
  // A hosted bridge keeps the initialized document through capability refreshes.
  // Failed HTTP documents never adopt a bridge and can be replaced on refresh.
  const src = createMemo(() => {
    const requested = props.params.src ?? "";
    return frame && adoptedWidgetPromptFrames.has(frame)
      ? (frame.getAttribute("src") ?? "")
      : requested;
  });
  const height = () => reportedHeight() ?? props.params.height;
  const Frame = () => {
    let element!: HTMLIFrameElement;
    onSettled(() => {
      widgetFramePromptActive.set(element, () => props.promptAllowed());
      widgetFrameResize.set(element, (nextHeight) => {
        setReportedHeight(nextHeight);
        props.params.onHeightChange?.(nextHeight);
      });
      const releaseTheme = registerWidgetThemeFrame(element, "*");
      props.onFrame(element);
      return () => {
        props.onFrame(undefined);
        releaseTheme();
        widgetFrameRegistry.delete(element);
        widgetFrameResize.delete(element);
        widgetFramePromptActive.delete(element);
      };
    });
    return (
      <iframe
        ref={(next) => {
          element = next;
          frame = next;
        }}
        src={src() || undefined}
        class="chat-tool-card__preview-frame"
        title={props.params.title}
        sandbox={props.params.sandbox ?? ""}
        style={height() ? `height:${height()}px;min-height:${height()}px` : ""}
        onLoad={() => {
          loadedWidgetFrames.add(element);
          widgetFrameRegistry.add(element);
          if (initialPromptCapable) {
            promptEligibleFrames.add(element);
            tryAdoptWidgetPromptPort(element);
          }
          postWidgetTheme(element);
          element.contentWindow?.postMessage({ type: WIDGET_CHAT_HOST_MESSAGE_TYPE }, "*");
        }}
      />
    );
  };
  if (initialPromptCapable) {
    installWidgetPromptOfferListener();
  }
  // Use a truthy tuple because an empty src still renders the sandboxed frame.
  const identity = createMemo(() => [src()] as const);
  return (
    <Show when={identity()} keyed>
      {(_key) => <Frame />}
    </Show>
  );
}

function PreviewFrame(props: {
  params: PreviewFrameParams;
  onExportSource: (source: WidgetExportSource) => void;
}) {
  let frame: HTMLIFrameElement | undefined;
  const presentation = createCanvasFramePresentation(
    () =>
      `${props.params.sandbox ?? ""}\0${props.params.frameKey ?? ""}\0${props.params.src ? 1 : 0}`,
    () => props.params.src,
    () =>
      Boolean(
        frame &&
        (adoptedWidgetPromptFrames.has(frame) ||
          (!props.params.sandbox?.includes("allow-scripts") && loadedWidgetFrames.has(frame))),
      ),
  );
  return (
    <Show when={presentation.identity()} keyed>
      {(_key) => (
        <WidgetFrame
          params={{ ...props.params, src: presentation.src() }}
          promptAllowed={presentation.active}
          onFrame={(next) => {
            frame = next;
            props.onExportSource(next);
          }}
        />
      )}
    </Show>
  );
}

const loadMcpAppView = () => import("../../../components/mcp-app-view-registration.ts");

const loadCanvasWidgetView = () => import("../../../components/canvas-widget-view.tsx");

function WidgetRegistration(props: { tagName: string; loadModule: () => Promise<unknown> }) {
  const ready = createMemo(() =>
    ensureCustomElementDefined(props.tagName, props.loadModule).then(() => null),
  );
  return (
    <Errored
      fallback={(error, reset) => (
        <LazyViewError
          error={error()}
          onRetry={() => reset()}
          actionLabel={t("common.retry")}
          inline
        />
      )}
    >
      <Loading>{ready()}</Loading>
    </Errored>
  );
}

function WidgetContent(props: {
  preview: CanvasToolPreview;
  sandbox: string;
  options?: WidgetCardOptions;
  onExportSource: (source: WidgetExportSource) => void;
}) {
  const managed = () =>
    props.preview.sandbox !== "strict" && isManagedCanvasDocumentPreview(props.preview);
  return (
    <Show
      when={props.preview.mcpApp}
      fallback={
        <Show
          when={managed()}
          fallback={
            <PreviewFrame
              onExportSource={props.onExportSource}
              params={{
                title: props.preview.title?.trim() || t("chat.toolCards.canvas"),
                src: resolveCanvasIframeUrl(
                  props.preview.url,
                  props.options?.canvasPluginSurfaceUrl,
                  props.options?.allowExternalEmbedUrls ?? false,
                ),
                frameKey: props.preview.url?.trim() || props.preview.viewId?.trim(),
                height:
                  props.options?.widgetLayout?.read(
                    `frame:${props.preview.url?.trim() || props.preview.viewId?.trim()}`,
                  ) ?? props.preview.preferredHeight,
                onHeightChange: (height) =>
                  props.options?.widgetLayout?.write(
                    `frame:${props.preview.url?.trim() || props.preview.viewId?.trim()}`,
                    height,
                  ),
                sandbox: props.sandbox,
                promptCapable: isInternalCanvasEntryUrl(props.preview.url),
              }}
            />
          }
        >
          {(_managed) => {
            return (
              <>
                <WidgetRegistration
                  tagName="openclaw-canvas-widget-view"
                  loadModule={loadCanvasWidgetView}
                />
                <CanvasWidgetMount
                  onElement={props.onExportSource}
                  docId={props.preview.viewId!.trim()}
                  sessionKey={props.options?.sessionKey ?? ""}
                  messageTimestamp={props.options?.messageTimestamp}
                  title={props.preview.title?.trim() || t("chat.toolCards.canvas")}
                  preferredHeight={
                    props.options?.widgetLayout?.read(`canvas:${props.preview.viewId!.trim()}`) ??
                    props.preview.preferredHeight
                  }
                  onHeightChange={(height) =>
                    props.options?.widgetLayout?.write(
                      `canvas:${props.preview.viewId!.trim()}`,
                      height,
                    )
                  }
                  allowScripts={props.sandbox.includes("allow-scripts")}
                  connectionGeneration={getCanvasWidgetFrameConnectionGeneration()}
                />
              </>
            );
          }}
        </Show>
      }
    >
      {(app) => {
        const key = () => `mcp:${app().viewId}`;
        const height = () =>
          props.options?.widgetLayout?.read(key()) ?? props.preview.preferredHeight ?? 600;
        return (
          <>
            <WidgetRegistration tagName="mcp-app-view" loadModule={loadMcpAppView} />
            <mcp-app-view
              prop:sessionKey={props.options?.sessionKey ?? ""}
              prop:viewId={app().viewId}
              prop:height={height()}
              prop:onHeightChange={(nextHeight: number) =>
                props.options?.widgetLayout?.write(key(), nextHeight)
              }
              style={{ display: "block", "min-height": `${height()}px` }}
              title={props.preview.title?.trim() || t("mcpApp.title")}
            />
          </>
        );
      }}
    </Show>
  );
}

function handleWidgetExportAction(
  value: WidgetAction,
  source: WidgetExportSource,
  title: string | undefined,
  toggleRawDetails: (() => boolean) | undefined,
): WidgetRawDetailsLabel | void {
  // Raw details belong to the enclosing tool card; canvas islands own their iframe DOM.
  if (value === "raw-details") {
    return toggleRawDetails?.() ? "chat.toolCards.hideRawDetails" : "chat.toolCards.showRawDetails";
  }
  const frame = source instanceof HTMLIFrameElement ? source : source?.previewFrame;
  if (!frame) {
    showToast({ message: t("chat.toolCards.widgetExportFailed") });
    return;
  }
  const documentHtml = source instanceof HTMLIFrameElement ? undefined : source?.documentHtml;
  void exportWidget(value, frame, title, { documentHtml })
    .then((result) => {
      if (result === "rerender-required") {
        showToast({ message: t("chat.toolCards.widgetExportRerender") });
      } else if (result === "html") {
        showToast({ message: t("chat.toolCards.widgetExportHtmlFallback") });
      } else if (value === "copy") {
        showToast({ message: t("common.copied") });
      }
    })
    .catch(() => {
      showToast({ message: t("chat.toolCards.widgetExportFailed") });
    });
}

function widgetActionsPlacementRef(enabled: () => boolean) {
  const presented = useContext(ContentPresentation);
  const active = createMemo(() => presented() && enabled());
  let element!: HTMLElement;
  const targets = () => {
    if (!active()) {
      return [];
    }
    const thread = element.closest<HTMLElement>(".chat-thread");
    return thread ? [element, thread] : [];
  };
  // Keep observation stable through content updates; only geometry needs a new frame.
  createResizeObserver(targets, () =>
    scheduleLayout(element, () => {
      const [target, thread] = targets();
      if (!target || !thread) {
        return undefined;
      }
      const clipRight =
        thread.getBoundingClientRect().left + thread.clientLeft + thread.clientWidth;
      const above = clipRight - target.getBoundingClientRect().right < 40;
      return () => element.toggleAttribute("data-widget-actions-above", above);
    }),
  );
  onSettled(() => () => cancelLayout(element));
  return (next: HTMLDivElement) => {
    element = next;
  };
}

function CanvasPreview(props: {
  preview: CanvasToolPreview;
  surface: string;
  options?: WidgetCardOptions;
}) {
  let exportSource: WidgetExportSource;
  const sandbox = () =>
    resolveEmbedSandbox(props.options?.embedSandboxMode ?? "scripts", props.preview.sandbox);
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
      board &&
      pinName() &&
      (props.preview.mcpApp
        ? board.canPinMcpApps && mcpAppViewId()
        : board.canPinWidgets &&
          sandbox().includes("allow-scripts") &&
          isManagedCanvasDocumentPreview(props.preview))
    );
  };
  const canExportImage = () => !props.preview.mcpApp && isInternalCanvasEntryUrl(props.preview.url);
  const hasMenu = () => canExportImage() || Boolean(props.options?.rawText);
  const hasActions = () => Boolean(canPin() || hasMenu());
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
      ref={widgetActionsPlacementRef(hasActions)}
      class="chat-tool-card__preview"
      data-content-kind={props.preview.mcpApp ? "mcp-app" : "canvas-html"}
      data-has-widget-actions={hasActions() ? "" : undefined}
      data-kind="canvas"
      data-surface={props.surface}
    >
      <Show when={hasActions()}>
        <div class="chat-tool-card__preview-actions" data-widget-actions>
          <Show when={pinTarget()} keyed>
            {(target) => <WidgetPinButton target={target} title={props.preview.title} />}
          </Show>
          <Show when={hasMenu()}>
            <WidgetCardMenu
              canExportImage={canExportImage()}
              hasRawDetails={Boolean(props.options?.rawText)}
              onAction={(value) =>
                handleWidgetExportAction(
                  value,
                  exportSource,
                  props.preview.title,
                  props.options?.toggleRawDetails,
                )
              }
            />
          </Show>
        </div>
      </Show>
      <div class="chat-tool-card__preview-panel" data-side="canvas">
        <WidgetContent
          preview={props.preview}
          sandbox={sandbox()}
          options={props.options}
          onExportSource={(source) => (exportSource = source)}
        />
      </div>
    </div>
  );
}

type ToolPreviewProps = {
  preview: ToolPreviewModel | undefined;
  surface: "chat_tool" | "chat_message";
  options?: WidgetCardOptions;
};

export function ToolPreview(props: ToolPreviewProps) {
  const browser = () =>
    props.preview?.kind === "browser-tab" && props.surface === "chat_tool"
      ? props.preview
      : undefined;
  const canvas = () =>
    props.preview?.kind === "canvas" &&
    props.surface === "chat_message" &&
    props.preview.surface === "assistant_message"
      ? props.preview
      : undefined;
  return (
    <Show
      when={browser()}
      fallback={
        <Show when={canvas()}>
          {(preview) => {
            const video = createMemo(() =>
              !preview().mcpApp ? parseYouTubeVideoUrl(preview().url) : undefined,
            );
            return (
              <Show
                when={video()}
                fallback={
                  <CanvasPreview
                    preview={preview()}
                    surface={props.surface}
                    options={props.options}
                  />
                }
              >
                {(item) => {
                  const Fallback = () => (
                    <openclaw-youtube-video>
                      <a href={item().watchUrl} target="_blank" rel="noopener noreferrer">
                        {preview().title?.trim() || t("chat.youtube.video")}
                        <Icon name="externalLink" />
                      </a>
                    </openclaw-youtube-video>
                  );
                  return (
                    <Show when={`${props.options?.sessionKey ?? ""}\0${item().watchUrl}`} keyed>
                      {(_key) => (
                        <Errored fallback={<Fallback />}>
                          <Loading fallback={<Fallback />}>
                            <YouTubeVideoCard
                              video={item()}
                              videoTitle={preview().title ?? ""}
                              enabled={
                                props.options?.embedSandboxMode !== "strict" &&
                                preview().sandbox !== "strict"
                              }
                            />
                          </Loading>
                        </Errored>
                      )}
                    </Show>
                  );
                }}
              </Show>
            );
          }}
        </Show>
      }
    >
      {(preview) => <BrowserTabCardHost preview={preview()} latest={false} />}
    </Show>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-youtube-video": HTMLAttributes<HTMLElement>;
    }
  }
}
