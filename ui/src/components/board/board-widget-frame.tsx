import { createMemo, Match, Show, Switch } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import { registerBoardEnglish } from "../../i18n/locales/en-board.ts";
import { EventStream } from "../../lib/board/provider-signals.ts";
import type { BoardWidget } from "../../lib/board/types.ts";
import type { BoardWidgetFrameUrl } from "../../lib/board/view-types.ts";
import { BoardWidgetSandboxHost } from "../../lib/board/widget-sandbox-host.ts";
import { remainingBoardWidgetTicketTtlMs } from "../../lib/board/widget-ticket-lifetime.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isGatewayAvailable } from "../../lib/gateway-availability.ts";
import { isLoopbackHostname } from "../../lib/gateway-locality.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { WidgetRenderTimeoutError } from "../../lib/widget-sandbox-host.ts";
import { postWidgetTheme, registerWidgetThemeFrame } from "../../lib/widget-theme.ts";
import { COMMAND_PALETTE_OPEN_EVENT } from "../command-palette-contract.ts";
import { McpAppConfirmation } from "../mcp-app-confirm-solid.tsx";
import { createMcpAppConfirm } from "../mcp-app-confirm.ts";
import { resolveGatewayHttpOrigin, resolveSandboxHostUrl } from "../sandbox-host.ts";
import { PanelLoadingSkeleton } from "../solid/panel-loading-skeleton.tsx";

registerEnglishCatalog(registerBoardEnglish);

// Keep in sync with the identical literal in chat widget-card.ts: a shared
// module is not worth its startup-bundle cost for one string.
const WIDGET_SIZE_MESSAGE_TYPE = "openclaw:widget-size";
const WIDGET_BOARD_HOST_MESSAGE_TYPE = "openclaw:widget-board-host";
const WIDGET_SCROLL_MESSAGE_TYPE = "openclaw:widget-scroll";
const WIDGET_COMMAND_PALETTE_MESSAGE_TYPE = "openclaw:widget-command-palette";
const WIDGET_SHORTCUT_HOST_MESSAGE_TYPE = "openclaw:widget-shortcut-host";
const MAX_FRAME_REFRESH_ATTEMPTS = 3;
const TICKET_REFRESH_LEAD_MS = 15_000;
const TICKET_REFRESH_MIN_DELAY_MS = 1_000;
const TICKET_REFRESH_RETRY_MS = 1_000;
const TICKET_REFRESH_MAX_RETRY_MS = 30_000;

function documentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

// Without mcp.apps.sandboxOrigin the sandbox URL is the gateway origin with the
// sandbox port substituted. On a non-loopback host that derived port often sits
// behind a reverse proxy or tunnel that does not route it, and the browser
// cannot distinguish that from a real authorization failure — so the terminal
// message keeps the authorization fact but adds the deployment hint operators
// otherwise never find.
function resolveBoardFrameFailureMessage(
  widget: Pick<BoardWidget, "sandboxOrigin">,
  resolvedSandboxOrigin: string,
): string {
  if (
    !widget.sandboxOrigin &&
    resolvedSandboxOrigin &&
    !isLoopbackHostname(new URL(resolvedSandboxOrigin).hostname)
  ) {
    return t("board.widget.sandboxOriginRequired");
  }
  return t("board.widget.frameAuthorizationFailed");
}

type FrameRefresh = (name: string) => Promise<void>;

type BoardWidgetFrameOwnerHost = {
  active: () => boolean;
  loadingCovered?: () => boolean;
  bridgeEnabled?: () => boolean;
  connected: () => boolean;
  context: () => ApplicationContext | undefined;
  refreshFrame: () => FrameRefresh | undefined;
  reportContentHeight: (name: string, height: number) => void;
  scrollBy: (deltaY: number) => void;
  resolveFrameUrl: () => BoardWidgetFrameUrl | undefined;
  widget: () => BoardWidget | undefined;
};

class BoardWidgetTicketRefresh {
  private timer: number | null = null;
  private attempts = 0;
  private scheduledTicket = "";

  constructor(
    private readonly currentTicket: () => string | undefined,
    private readonly canRefresh: () => boolean,
  ) {}

  private clearTimer(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  reset(): void {
    this.clearTimer();
    this.attempts = 0;
    this.scheduledTicket = "";
  }

  schedule(widget: BoardWidget | undefined, refresh: FrameRefresh | undefined): void {
    const ticket = widget?.viewTicket;
    const remainingTtlMs = widget ? remainingBoardWidgetTicketTtlMs(widget) : undefined;
    if (!this.canRefresh() || !widget || !refresh || !ticket || remainingTtlMs === undefined) {
      this.reset();
      return;
    }
    if (this.scheduledTicket === ticket) {
      return;
    }
    this.clearTimer();
    this.attempts = 0;
    this.scheduledTicket = ticket;
    const delayMs = Math.max(TICKET_REFRESH_MIN_DELAY_MS, remainingTtlMs - TICKET_REFRESH_LEAD_MS);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.refresh(widget.name, ticket, refresh);
    }, delayMs);
  }

  private refresh(name: string, ticket: string, refresh: FrameRefresh): void {
    if (!this.canRefresh()) {
      this.reset();
      return;
    }
    if (this.currentTicket() !== ticket || this.scheduledTicket !== ticket) {
      return;
    }
    this.attempts += 1;
    const retryIfUnchanged = () => {
      if (this.currentTicket() !== ticket || this.scheduledTicket !== ticket) {
        return;
      }
      // A fulfilled refresh may be discarded by a superseding provider mutation.
      // Retry until this exact expiring ticket is actually replaced.
      this.clearTimer();
      this.timer = window.setTimeout(
        () => {
          this.timer = null;
          this.refresh(name, ticket, refresh);
        },
        Math.min(TICKET_REFRESH_RETRY_MS * this.attempts, TICKET_REFRESH_MAX_RETRY_MS),
      );
    };
    void refresh(name).then(retryIfUnchanged, retryIfUnchanged);
  }
}

export type BoardWidgetFrameOwner = ReturnType<typeof createBoardWidgetFrame>;
export function createBoardWidgetFrame(host: BoardWidgetFrameOwnerHost) {
  const changes = new EventStream<void>();
  let initialTheme = document.documentElement.dataset.themeMode === "light" ? "light" : "dark";
  let sandboxRequestUrl = "";
  let frameError = "";
  let frameElement: HTMLIFrameElement | undefined;
  let releaseTheme: (() => void) | undefined;
  let waiting = false;
  let renderStalled = false;
  let frameFailureKey = "";
  let frameRefreshAttempts = 0;
  let frameProbeGeneration = 0;
  let boardHostNonce = "";
  let keyboardHostNonce = "";
  let lastFrameUrl = "";
  let sandboxOrigin = "";
  let sandboxHost: BoardWidgetSandboxHost | null = null;
  let contentVisible = false;
  let initialPaint = true;
  const confirmation = createMcpAppConfirm();
  const ticketRefresh = new BoardWidgetTicketRefresh(
    () => host.widget()?.viewTicket,
    () => host.active() && !documentHidden() && gatewayAvailable(),
  );
  const handleVisibilityChange = (): void => {
    if (documentHidden()) {
      ticketRefresh.reset();
      return;
    }
    ticketRefresh.schedule(host.widget(), host.refreshFrame());
  };
  const handleWindowMessage = (event: MessageEvent): void => {
    if (!host.connected()) {
      return;
    }
    const frame = frameElement;
    if (!frame?.isConnected || event.source !== frame.contentWindow) {
      return;
    }
    const widget = host.widget();
    if (!host.active()) {
      if (event.origin === sandboxOrigin) {
        sandboxHost?.handleMessage(event);
      }
      return;
    }
    // SAFETY: Fields remain unknown; each use below checks its discriminant, numeric type, or nonce.
    const data = event.data as {
      type?: unknown;
      height?: unknown;
      deltaY?: unknown;
      nonce?: unknown;
    } | null;
    if (
      widget &&
      data?.type === WIDGET_SIZE_MESSAGE_TYPE &&
      typeof data.height === "number" &&
      Number.isFinite(data.height) &&
      data.height > 0
    ) {
      host.reportContentHeight(widget.name, data.height);
    }
    if (
      widget &&
      data?.type === WIDGET_SCROLL_MESSAGE_TYPE &&
      data.nonce === boardHostNonce &&
      typeof data.deltaY === "number" &&
      Number.isFinite(data.deltaY) &&
      data.deltaY !== 0
    ) {
      host.scrollBy(data.deltaY);
    }
    if (
      widget &&
      data?.type === WIDGET_COMMAND_PALETTE_MESSAGE_TYPE &&
      keyboardHostNonce &&
      data.nonce === keyboardHostNonce &&
      event.origin === sandboxOrigin &&
      frame.isConnected &&
      document.activeElement === frame &&
      !document.openClawModalLayers?.size
    ) {
      window.dispatchEvent(new CustomEvent(COMMAND_PALETTE_OPEN_EVENT));
    }
    if (!widget?.viewTicket || event.origin !== sandboxOrigin) {
      return;
    }
    syncSandboxHost(frame, widget)?.handleMessage(event);
  };
  let stopMessages: (() => void) | undefined;
  let stopVisibility: (() => void) | undefined;
  function gatewayAvailable(): boolean {
    const snapshot = host.context()?.gateway.snapshot;
    return !snapshot || isGatewayAvailable(snapshot);
  }

  function suspend(): void {
    stopWork();
    sandboxHost?.setActive(false);
  }

  function stopWork(): void {
    confirmation.cancel();
    stopVisibility?.();
    stopVisibility = undefined;
    ticketRefresh.reset();
  }

  function setError(error: string, notify = true): void {
    if (frameError === error) {
      return;
    }
    frameError = error;
    if (notify) {
      changes.emit();
    }
  }

  function resetFailures(notify = true): void {
    confirmation.cancel();
    waiting = false;
    renderStalled = false;
    contentVisible = false;
    initialPaint = false;
    frameProbeGeneration += 1;
    frameFailureKey = "";
    frameRefreshAttempts = 0;
    setError("", notify);
    sandboxHost?.reset();
  }

  function resolveSandboxFrameUrl(widget: BoardWidget): string | undefined {
    const gatewayUrl = host.context()?.gateway.connection.gatewayUrl;
    if (
      !widget.sandboxUrl ||
      !widget.sandboxPort ||
      !widget.viewTicket ||
      gatewayUrl === undefined
    ) {
      return undefined;
    }
    const url = new URL(
      resolveSandboxHostUrl(
        widget.sandboxUrl,
        widget.sandboxPort,
        widget.sandboxOrigin,
        gatewayUrl,
        window.location.origin,
      ),
    );
    if (url.href !== sandboxRequestUrl) {
      sandboxRequestUrl = url.href;
      initialTheme = document.documentElement.dataset.themeMode === "light" ? "light" : "dark";
      if (frameElement) {
        frameElement.style.colorScheme = initialTheme;
      }
    }
    // Keep the seed stable until navigation; theme messages update the mounted shell.
    url.hash = `theme=${initialTheme}`;
    sandboxOrigin = url.origin;
    return url.href;
  }

  function sandboxHostOptions(
    frame: HTMLIFrameElement,
    widget: BoardWidget,
  ): ConstructorParameters<typeof BoardWidgetSandboxHost>[0] | undefined {
    const resolveFrameUrl = host.resolveFrameUrl();
    if (!resolveFrameUrl) {
      return undefined;
    }
    const context = host.context();
    const client = context?.gateway.snapshot.client;
    const connectionRevision = context?.gateway.connectionRevision;
    const hello = context?.gateway.snapshot.hello;
    return {
      frame,
      widget,
      bridgeEnabled: host.bridgeEnabled?.() ?? true,
      // A lifecycle pause does not retire this authenticated connection or its ticket.
      connected: !context || context.gateway.snapshot.phase === "connected",
      sandboxOrigin,
      sandboxUrl: frame.src,
      sourceOrigin: resolveGatewayHttpOrigin(
        context?.gateway.connection.gatewayUrl ?? "",
        window.location.origin,
      ),
      controlUiBaseUrl: `${window.location.origin}${context?.basePath ?? ""}`,
      client: context?.gateway.snapshot.client ?? undefined,
      resolveFrameUrl,
      confirmPrompt: (text) =>
        confirmation.request({
          frame,
          title: widget.title || widget.name,
          text,
          kind: "message",
          isCurrent: () => {
            const current = host.widget();
            const gateway = host.context()?.gateway;
            return (
              host.active() &&
              host.connected() &&
              gatewayAvailable() &&
              frame === frameElement &&
              frame.isConnected &&
              current?.name === widget.name &&
              current.revision === widget.revision &&
              current.viewGeneration === widget.viewGeneration &&
              gateway?.snapshot.client === client &&
              gateway?.connectionRevision === connectionRevision &&
              gateway?.snapshot.hello === hello
            );
          },
        }),
      onFrameUrl: (url) => {
        lastFrameUrl = url;
      },
      onLoadFailed: () => waitForConnection(),
      onUnauthorized: (currentWidget) => api.refreshFailedFrame(currentWidget),
      onReadyTimeout: () => waitForConnection(),
      onPending: () => waitForConnection(),
      onLoaded: () => {
        waiting = false;
        contentVisible = false;
        frameFailureKey = "";
        frameRefreshAttempts = 0;
        setError("", false);
        changes.emit();
      },
      onRendered: () => {
        // The proxy replaces its inner document after the outer load event.
        // Bind host state to that rendered document, including saved widgets
        // whose wrapper predates the private bridge-ready notification.
        api.postBoardHostState(frame);
        waiting = false;
        renderStalled = false;
        setError("");
        initialPaint = false;
        contentVisible = true;
        changes.emit();
      },
      onError: (error) => {
        if (error instanceof WidgetRenderTimeoutError) {
          initialPaint = false;
          renderStalled = true;
          changes.emit();
          return;
        }
        setError(formatUiError(error));
      },
    };
  }

  function waitForConnection(): void {
    waiting = true;
    changes.emit();
  }

  function updateSandboxHost(): void {
    const frame = frameElement;
    const widget = host.widget();
    if (
      !frame?.isConnected ||
      !widget ||
      !widget.sandboxUrl ||
      !widget.sandboxPort ||
      !widget.viewTicket
    ) {
      sandboxHost?.dispose();
      sandboxHost = null;
      return;
    }
    syncSandboxHost(frame, widget);
  }

  function syncSandboxHost(
    frame: HTMLIFrameElement,
    widget: BoardWidget,
  ): BoardWidgetSandboxHost | undefined {
    const options = sandboxHostOptions(frame, widget);
    if (!options) {
      return undefined;
    }
    const active = host.active() && gatewayAvailable();
    // Pause before updating options, then resume only under current availability.
    // Reuse the existing inactive lifecycle so pending work is fenced without
    // requiring a new authorization ticket after suspension is canceled.
    if (!active) {
      sandboxHost?.setActive(false);
    }
    if (!sandboxHost || sandboxHost.frame !== frame) {
      sandboxHost?.dispose();
      sandboxHost = new BoardWidgetSandboxHost(options);
    } else {
      sandboxHost.update(options);
    }
    sandboxHost.setActive(active);
    return sandboxHost;
  }
  const api = {
    retryContent(): void {
      renderStalled = false;
      waiting = false;
      sandboxHost?.reset();
      changes.emit();
    },
    get error() {
      return frameError;
    },
    get presentationReady(): boolean {
      return contentVisible || waiting || renderStalled || Boolean(frameError);
    },
    connect(): void {
      stopMessages ??= listen(window, "message", handleWindowMessage);
      if (host.active()) {
        stopVisibility ??= listen(document, "visibilitychange", handleVisibilityChange);
      }
    },
    disconnect(): void {
      releaseTheme?.();
      releaseTheme = undefined;
      frameProbeGeneration += 1;
      contentVisible = false;
      stopWork();
      stopMessages?.();
      stopMessages = undefined;
      sandboxHost?.dispose();
      sandboxHost = null;
    },
    activityChanged(): void {
      if (host.active()) {
        api.connect();
        sandboxHost?.setActive(gatewayAvailable());
        // The inner document may have finished loading while this tab was hidden.
        const frame = frameElement;
        if (frame?.isConnected) {
          api.postBoardHostState(frame);
        }
      } else {
        // Hidden dashboard cells retain their iframe and sandbox handshake;
        // terminal disconnect is the only lifecycle edge that disposes them.
        suspend();
      }
    },
    widgetChanged(previous: BoardWidget, current: BoardWidget | undefined): void {
      if (previous.name !== current?.name || previous.revision !== current?.revision) {
        resetFailures();
        return;
      }
      if (!frameError) {
        return;
      }
      const nextFrameUrl = host.resolveFrameUrl()?.(current.name, current.revision) ?? "";
      if (nextFrameUrl && nextFrameUrl !== lastFrameUrl) {
        // A newly minted ticket gets one authorization probe, but keeps the
        // existing remint budget until that probe proves the frame healthy.
        setError("");
      }
    },
    update(): void {
      confirmation.update();
      if (!host.active()) {
        suspend();
        return;
      }
      api.connect();
      ticketRefresh.schedule(host.widget(), host.refreshFrame());
      updateSandboxHost();
    },
    refreshFailedFrame(widget: BoardWidget): void {
      if (!host.active()) {
        return;
      }
      frameProbeGeneration += 1;
      const failureKey = `${widget.name}:${widget.revision}`;
      if (frameFailureKey !== failureKey) {
        resetFailures(false);
        frameFailureKey = failureKey;
      }
      if (frameRefreshAttempts >= MAX_FRAME_REFRESH_ATTEMPTS) {
        setError(resolveBoardFrameFailureMessage(widget, sandboxOrigin));
        return;
      }
      const refreshFrame = host.refreshFrame();
      if (!refreshFrame) {
        setError(t("board.widget.frameResolverMissing"));
        return;
      }
      frameRefreshAttempts += 1;
      const refreshGeneration = frameProbeGeneration;
      void refreshFrame(widget.name).catch((error: unknown) => {
        const current = host.widget();
        if (
          host.connected() &&
          frameProbeGeneration === refreshGeneration &&
          current?.name === widget.name &&
          current.revision === widget.revision
        ) {
          setError(formatUiError(error));
        }
      });
      if (frameRefreshAttempts >= MAX_FRAME_REFRESH_ATTEMPTS) {
        setError(resolveBoardFrameFailureMessage(widget, sandboxOrigin));
      }
    },
    verifyAuthorization(event: Event, widget: BoardWidget): void {
      const frame = event.currentTarget;
      const src = frame instanceof HTMLIFrameElement ? (frame.getAttribute("src") ?? "") : "";
      if (!src.startsWith("/__openclaw__/board/")) {
        return;
      }
      const probeGeneration = frameProbeGeneration + 1;
      frameProbeGeneration = probeGeneration;
      const isCurrentProbe = () =>
        frame instanceof HTMLIFrameElement &&
        frame.isConnected &&
        frame.getAttribute("src") === src &&
        frameProbeGeneration === probeGeneration &&
        host.active() &&
        host.widget()?.name === widget.name &&
        host.widget()?.revision === widget.revision;
      // View tickets are reusable HMAC bindings until expiry. Iframe load events
      // hide HTTP status, so a credentialed probe is the only 401 signal.
      void fetch(src, { cache: "no-store" })
        .then((response) => {
          if (!isCurrentProbe()) {
            return;
          }
          if (response.status === 401) {
            api.refreshFailedFrame(widget);
          } else if (response.ok) {
            resetFailures();
          }
        })
        .catch(() => {
          if (isCurrentProbe()) {
            api.refreshFailedFrame(widget);
          }
        });
    },
    postBoardHostState(frame: HTMLIFrameElement): void {
      releaseTheme?.();
      releaseTheme = registerWidgetThemeFrame(frame, sandboxOrigin || "*");
      boardHostNonce = generateUUID();
      keyboardHostNonce = sandboxOrigin ? generateUUID() : "";
      postWidgetTheme(frame, sandboxOrigin || "*");
      frame.contentWindow?.postMessage(
        { type: WIDGET_BOARD_HOST_MESSAGE_TYPE, nonce: boardHostNonce },
        sandboxOrigin || "*",
      );
      if (keyboardHostNonce) {
        frame.contentWindow?.postMessage(
          { type: WIDGET_SHORTCUT_HOST_MESSAGE_TYPE, nonce: keyboardHostNonce },
          sandboxOrigin,
        );
      }
    },
    // Forward the widget owner's event stream to its projection subscribers.
    subscribe: (listener: () => void) => changes.subscribe(listener),
    confirmation,
    bindFrame(frame: HTMLIFrameElement) {
      releaseTheme?.();
      releaseTheme = undefined;
      frame.style.colorScheme = initialTheme;
      frameElement = frame;
    },
    prepareView(value: BoardWidget) {
      const resolveFrameUrl = host.resolveFrameUrl();
      if (!resolveFrameUrl) {
        throw new Error(t("board.widget.frameResolverMissing"));
      }
      const src = resolveFrameUrl(value.name, value.revision);
      lastFrameUrl = src;
      const sandboxSrc = resolveSandboxFrameUrl(value);
      if (!sandboxSrc && (value.sandboxUrl || value.sandboxPort || value.viewTicket)) {
        throw new Error(t("board.widget.sandboxUnavailable"));
      }
      return {
        src,
        sandboxSrc,
        visible: contentVisible,
        painting: initialPaint && !waiting && !renderStalled,
        waiting,
        stalled: renderStalled,
        covered: host.loadingCovered?.(),
      };
    },
    restoreFocus(event: Event) {
      const frame = event.currentTarget;
      if (
        frame instanceof HTMLIFrameElement &&
        host.active() &&
        document.activeElement === frame &&
        keyboardHostNonce
      ) {
        frame.contentWindow?.postMessage(
          { type: "openclaw:widget-shortcut-focus", nonce: keyboardHostNonce },
          sandboxOrigin,
        );
      }
    },
    handleFrameError(widget: BoardWidget) {
      if (sandboxHost) {
        sandboxHost.handleFrameError();
      } else {
        api.refreshFailedFrame(widget);
      }
    },
  };
  return api;
}

export function BoardWidgetFrame(props: {
  state: () => BoardWidgetFrameOwner;
  current: () => BoardWidget;
}) {
  const view = createMemo(() => props.state().prepareView(props.current()));
  return (
    <Show
      when={Boolean(view().sandboxSrc)}
      fallback={
        <iframe
          ref={(frame) => props.state().bindFrame(frame)}
          class="board-widget__frame"
          allow="fullscreen"
          sandbox="allow-scripts"
          referrerpolicy="no-referrer"
          loading="lazy"
          title={props.current().title || props.current().name}
          src={view().src}
          onError={() => props.state().refreshFailedFrame(props.current())}
          onLoad={(event) => {
            props.state().postBoardHostState(event.currentTarget);
            props.state().verifyAuthorization(event, props.current());
          }}
        />
      }
    >
      <div class="board-widget__frame-pane">
        <McpAppConfirmation confirmation={props.state().confirmation} />
        <Show when={!view().visible && !view().covered}>
          <Switch
            fallback={
              <PanelLoadingSkeleton
                variant="discussion"
                label={t("common.loading")}
                compact={false}
                overlay
              />
            }
          >
            <Match when={view().stalled}>
              <div class="board-widget__notice" role="status">
                {t("board.widget.resourceUnavailable")}
                <button class="btn btn--small" onClick={() => props.state().retryContent()}>
                  {t("common.retry")}
                </button>
              </div>
            </Match>
            <Match when={view().waiting}>
              <div class="board-widget__notice" role="status">
                {t("board.widget.waitingForConnection")}
              </div>
            </Match>
          </Switch>
        </Show>
        <iframe
          ref={(frame) => props.state().bindFrame(frame)}
          class="board-widget__frame"
          allow="fullscreen"
          style={{ opacity: view().visible || view().painting ? undefined : 0 }}
          inert={!view().visible}
          sandbox="allow-scripts allow-same-origin allow-forms"
          referrerpolicy="origin"
          loading="eager"
          title={props.current().title || props.current().name}
          src={view().sandboxSrc}
          onOpenclaw:restore-focus={(event: Event) => props.state().restoreFocus(event)}
          onError={() => props.state().handleFrameError(props.current())}
          onLoad={(event) => props.state().postBoardHostState(event.currentTarget)}
        />
      </div>
    </Show>
  );
}
