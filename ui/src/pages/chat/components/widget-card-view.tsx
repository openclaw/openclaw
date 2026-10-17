import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
  untrack,
  useContext,
} from "solid-js";
import { ensureCustomElementDefined } from "../../../app/lazy-custom-element.ts";
import { dispatchWidgetPrompt } from "../../../components/mcp-app-security.ts";
import { Icon } from "../../../components/solid/icon.tsx";
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
import { t } from "../../../lib/reactive/i18n.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { showToast } from "../../../lib/toast.ts";
import { postWidgetTheme } from "../../../lib/widget-theme.ts";
import { CanvasWidgetMount } from "./canvas-widget-mount.tsx";
import "./browser-tab-card.tsx";
import {
  WidgetCardMenu,
  type WidgetAction,
  type WidgetRawDetailsLabel,
} from "./widget-card-menu.tsx";
import { exportWidget } from "./widget-export.ts";

registerMcpAppEnglish();

type WidgetCardOptions = {
  rawText?: string | null;
  canvasPluginSurfaceUrl?: string | null;
  embedSandboxMode?: EmbedSandboxMode;
  allowExternalEmbedUrls?: boolean;
  sessionKey?: string;
  messageTimestamp?: number;
  boardProvider?: BoardProvider;
  widgetLayout?: import("../session-message-cache.ts").ChatWidgetLayout;
  browserTabRevision?: string;
  browserTabLatest?: boolean;
};

async function pinWidget(
  event: Event,
  preview: CanvasToolPreview,
  provider: BoardProvider,
  name: string,
  mcpAppViewId?: string,
): Promise<void> {
  const viewId = mcpAppViewId || preview.viewId?.trim();
  if (!viewId) {
    return;
  }
  const button = event.currentTarget;
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }
  button.disabled = true;
  const pendingLabel = t("chat.toolCards.pinToDashboardPending");
  button.title = button.ariaLabel = pendingLabel;
  try {
    const identity = {
      name,
      ...(preview.title?.trim() ? { title: preview.title.trim() } : {}),
    };
    await (mcpAppViewId
      ? provider.pinMcpApp({ ...identity, viewId })
      : provider.pinWidget({ ...identity, docId: viewId }));
    const pinnedLabel = t("chat.toolCards.pinnedToDashboard");
    button.title = button.ariaLabel = pinnedLabel;
    button.dataset.pinned = "true";
  } catch {
    button.disabled = false;
    button.ariaLabel = t("chat.toolCards.pinToDashboard");
    const failureLabel = t("chat.toolCards.pinToDashboardFailed");
    button.title = failureLabel;
    showToast({ message: failureLabel });
  }
}

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
  port.addEventListener("message", (message: MessageEvent) => {
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
  window.addEventListener("message", (event: MessageEvent) => {
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
  window.addEventListener("message", (event: MessageEvent) => {
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
  onFrame: (frame: HTMLIFrameElement) => void;
}) {
  let frame: HTMLIFrameElement | undefined;
  const [reportedHeight, setReportedHeight] = createSignal<number>();
  // Prompt policy is fixed by the outer URL/sandbox identity.
  const promptCapable = untrack(() => props.params.promptCapable);
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
    createEffect(
      () => [props.promptAllowed, props.params.onHeightChange] as const,
      ([promptAllowed, onHeightChange]) => {
        widgetFramePromptActive.set(element, promptAllowed);
        widgetFrameResize.set(element, (nextHeight) => {
          setReportedHeight(nextHeight);
          onHeightChange?.(nextHeight);
        });
      },
    );
    onCleanup(() => {
      widgetFrameRegistry.delete(element);
      widgetFrameResize.delete(element);
      widgetFramePromptActive.delete(element);
    });
    return (
      <iframe
        ref={(next) => {
          element = next;
          frame = next;
          props.onFrame(next);
        }}
        src={src() || undefined}
        class="chat-tool-card__preview-frame"
        title={props.params.title}
        sandbox={props.params.sandbox ?? ""}
        style={height() ? `height:${height()}px;min-height:${height()}px` : ""}
        onLoad={() => {
          loadedWidgetFrames.add(element);
          widgetFrameRegistry.add(element);
          if (promptCapable) {
            promptEligibleFrames.add(element);
            tryAdoptWidgetPromptPort(element);
          }
          postWidgetTheme(element);
          element.contentWindow?.postMessage({ type: WIDGET_CHAT_HOST_MESSAGE_TYPE }, "*");
        }}
      />
    );
  };
  if (promptCapable) {
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

function PreviewFrame(props: { params: PreviewFrameParams }) {
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
          }}
        />
      )}
    </Show>
  );
}

const loadMcpAppView = async () => {
  await import("../../../components/mcp-app-view-registration.ts");
};

const loadCanvasWidgetView = () => import("../../../components/canvas-widget-view.tsx");
const loadYouTubeVideo = () => import("./youtube-video-card.tsx");

function WidgetContent(props: {
  preview: CanvasToolPreview;
  sandbox: string;
  options?: WidgetCardOptions;
}) {
  const mcp = () => props.preview.mcpApp;
  const managed = () =>
    props.preview.sandbox !== "strict" && isManagedCanvasDocumentPreview(props.preview);
  return (
    <Show
      when={mcp()}
      fallback={
        <Show
          when={managed()}
          fallback={
            <PreviewFrame
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
            void ensureCustomElementDefined(
              "openclaw-canvas-widget-view",
              loadCanvasWidgetView,
            ).catch((error: unknown) =>
              console.error("[openclaw] failed to load widget view", error),
            );
            return (
              <CanvasWidgetMount
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
            );
          }}
        </Show>
      }
    >
      {(app) => {
        void ensureCustomElementDefined("mcp-app-view", loadMcpAppView).catch((error: unknown) => {
          console.error("[openclaw] failed to load MCP App view", error);
        });
        const key = () => `mcp:${app().viewId}`;
        const height = () =>
          props.options?.widgetLayout?.read(key()) ?? props.preview.preferredHeight ?? 600;
        return (
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
        );
      }}
    </Show>
  );
}

function handleWidgetExportAction(
  value: WidgetAction,
  dropdown: HTMLElement,
  title: string | undefined,
): WidgetRawDetailsLabel | void {
  // Raw details belong to the enclosing tool card; canvas islands own their iframe DOM.
  if (value === "raw-details") {
    const host = dropdown.closest(".chat-tool-card__widget-host");
    const toggle = host?.querySelector<HTMLButtonElement>(
      ".chat-tool-card__widget-raw .chat-tool-card__raw-toggle",
    );
    // Solid commits the toggle after this handler; derive its next label before clicking.
    const willExpand = toggle?.getAttribute("aria-expanded") !== "true";
    toggle?.click();
    return toggle && willExpand ? "chat.toolCards.hideRawDetails" : "chat.toolCards.showRawDetails";
  }
  const frame = dropdown
    .closest(".chat-tool-card__preview")
    ?.querySelector<HTMLIFrameElement>(".chat-tool-card__preview-frame");
  if (!frame) {
    showToast({ message: t("chat.toolCards.widgetExportFailed") });
    return;
  }
  const documentHtml = frame.closest("openclaw-canvas-widget-view")?.documentHtml;
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

function widgetActionsPlacementRef(
  enabled: () => boolean,
  options: () => WidgetCardOptions | undefined,
) {
  const presented = useContext(ContentPresentation);
  const active = createMemo(() => presented() && enabled());
  let element: HTMLElement | undefined;
  // Synchronize action placement with the transcript's DOM clipping geometry.
  createEffect(
    () => [active(), options()] as const,
    ([isActive]) => {
      if (!isActive || !element || typeof ResizeObserver === "undefined") {
        return undefined;
      }
      const target = element;
      let thread: HTMLElement | null = null;
      let frame: number | undefined;
      const placeActions = () => {
        if (!thread) {
          return;
        }
        const clipRight =
          thread.getBoundingClientRect().left + thread.clientLeft + thread.clientWidth;
        target.toggleAttribute(
          "data-widget-actions-above",
          clipRight - target.getBoundingClientRect().right < 40,
        );
      };
      // Keep layout writes out of resize delivery, including transcript rerenders.
      const observer = new ResizeObserver(() => {
        if (frame !== undefined) {
          return;
        }
        frame = requestAnimationFrame(() => {
          frame = undefined;
          placeActions();
        });
      });
      // Content updates can arrive during resize delivery. Reattach after insertion
      // in the next frame so the shallower thread cannot become a skipped delivery.
      frame = requestAnimationFrame(() => {
        frame = undefined;
        thread = target.closest<HTMLElement>(".chat-thread");
        if (!thread) {
          return;
        }
        observer.observe(target);
        observer.observe(thread);
        // First placement must not wait for the observer's initial delivery.
        placeActions();
      });
      return () => {
        if (frame !== undefined) {
          cancelAnimationFrame(frame);
        }
        observer.disconnect();
      };
    },
  );
  return (next: HTMLDivElement) => {
    element = next;
  };
}

function CanvasPreview(props: {
  preview: CanvasToolPreview;
  surface: string;
  options?: WidgetCardOptions;
}) {
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
  const pinned = () =>
    Boolean(
      pinName() && provider()?.snapshot$.value.widgets.find((widget) => widget.name === pinName()),
    );
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
  const pinLabel = () =>
    t(pinned() ? "chat.toolCards.pinnedToDashboard" : "chat.toolCards.pinToDashboard");
  return (
    <div
      ref={widgetActionsPlacementRef(hasActions, () => props.options)}
      class="chat-tool-card__preview"
      data-content-kind={props.preview.mcpApp ? "mcp-app" : "canvas-html"}
      data-has-widget-actions={hasActions() ? "" : undefined}
      data-kind="canvas"
      data-surface={props.surface}
    >
      <Show when={hasActions()}>
        <div class="chat-tool-card__preview-actions" data-widget-actions>
          <Show when={canPin()}>
            <button
              class="btn btn--ghost btn--icon chat-tool-card__widget-action"
              type="button"
              data-pin-widget
              disabled={pinned()}
              data-pinned={pinned() ? "" : undefined}
              title={pinLabel()}
              aria-label={pinLabel()}
              onClick={(event) =>
                void pinWidget(event, props.preview, provider()!, pinName()!, mcpAppViewId())
              }
            >
              <Icon name="pin" />
            </button>
          </Show>
          <Show when={hasMenu()}>
            <WidgetCardMenu
              canExportImage={canExportImage()}
              hasRawDetails={Boolean(props.options?.rawText)}
              onAction={(value, menu) => handleWidgetExportAction(value, menu, props.preview.title)}
            />
          </Show>
        </div>
      </Show>
      <div class="chat-tool-card__preview-panel" data-side="canvas">
        <WidgetContent preview={props.preview} sandbox={sandbox()} options={props.options} />
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
                  void ensureCustomElementDefined("openclaw-youtube-video", loadYouTubeVideo).catch(
                    (error: unknown) =>
                      console.error("[openclaw] failed to load YouTube player", error),
                  );
                  const key = createMemo(
                    () => `${props.options?.sessionKey ?? ""}\0${item().watchUrl}`,
                  );
                  return (
                    <Show when={key()} keyed>
                      {(_key) => (
                        <openclaw-youtube-video
                          prop:video={item()}
                          prop:videoTitle={preview().title ?? ""}
                          prop:enabled={
                            props.options?.embedSandboxMode !== "strict" &&
                            preview().sandbox !== "strict"
                          }
                        >
                          <a href={item().watchUrl} target="_blank" rel="noopener noreferrer">
                            {preview().title?.trim() || t("chat.youtube.video")}
                            <Icon name="externalLink" />
                          </a>
                        </openclaw-youtube-video>
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
      {(preview) => (
        <openclaw-browser-tab-card
          prop:preview={preview()}
          prop:revision={props.options?.browserTabRevision}
          prop:latest={props.options?.browserTabLatest ?? false}
        />
      )}
    </Show>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-browser-tab-card": HTMLAttributes<HTMLElement> & {
        "prop:preview": Extract<ToolPreviewModel, { kind: "browser-tab" }>;
        "prop:revision"?: string;
        "prop:latest": boolean;
      };
      "openclaw-youtube-video": HTMLAttributes<HTMLElement> & {
        "prop:video": import("../../../lib/chat/youtube-video.ts").YouTubeVideo;
        "prop:videoTitle": string;
        "prop:enabled": boolean;
      };
    }
  }
}
