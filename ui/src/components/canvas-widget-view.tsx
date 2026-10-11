import {
  GatewayProtocolRequestError,
  GatewayProtocolRequestTimeoutError,
  resolveSafeTimeoutDelayMs,
} from "@openclaw/gateway-client/browser";
import type { CanvasDocumentViewResult } from "@openclaw/gateway-protocol";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  Show,
  createEffect,
  createMemo,
  createRenderEffect,
  createSignal,
  onCleanup,
  onSettled,
} from "solid-js";
import type { ApplicationContext } from "../app/context.ts";
import { hasOperatorReadAccess } from "../app/operator-access.ts";
import { getCanvasWidgetFrameConnectionGeneration } from "../lib/chat/canvas-widget-frame-generation.ts";
import { formatUiError } from "../lib/format-error.ts";
import { isAwaitingGatewayFailure, isGatewayAvailable } from "../lib/gateway-availability.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { t } from "../lib/reactive/i18n.ts";
import { generateUUID } from "../lib/uuid.ts";
import {
  WidgetSandboxHost,
  WIDGET_LOAD_TIMEOUT_MS,
  WIDGET_LOAD_NOTICE_MS,
} from "../lib/widget-sandbox-host.ts";
import { registerWidgetThemeFrame, postWidgetTheme } from "../lib/widget-theme.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import { forwardChatWheelToTranscript } from "../pages/chat/chat-scroll-input.ts";
import { allowWidgetPrompt, dispatchWidgetPrompt } from "./mcp-app-security.ts";
import { resolveSandboxHostUrl } from "./sandbox-host.ts";

type WidgetClient = NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
type ViewBinding = {
  client: WidgetClient;
  generation: number;
  docId: string;
  sessionKey: string;
  connectionRevision: number;
  gatewayUrl: string;
  profileId: string | null;
  recoveryScope: string | undefined;
};
// One wake attempt per session/document per page load, including remounts.
const reportedRuntimeErrors = new Set<string>();
// Fresh renders ping the agent; old restored history only shows the notice.
const WIDGET_RUNTIME_ERROR_REPORT_WINDOW_MS = 10 * 60_000;
const pendingViews = new WeakMap<
  WidgetClient,
  {
    generation: number;
    requests: Map<string, Promise<CanvasDocumentViewResult>>;
  }
>();

function loadCanvasView(binding: ViewBinding): Promise<CanvasDocumentViewResult> {
  let pending = pendingViews.get(binding.client);
  if (!pending || pending.generation !== binding.generation) {
    pending = { generation: binding.generation, requests: new Map() };
    pendingViews.set(binding.client, pending);
  }
  const existing = pending.requests.get(binding.docId);
  if (existing) {
    return existing;
  }
  const request = binding.client.request<CanvasDocumentViewResult>(
    "canvas.document.view",
    { docId: binding.docId },
    { timeoutMs: WIDGET_LOAD_TIMEOUT_MS },
  );
  // Canvas also supports replacing a named document. Share concurrent reads,
  // but only the mounted view retains bytes; a remount revalidates the source.
  if (pending.requests.size < 32) {
    const requests = pending.requests;
    requests.set(binding.docId, request);
    void request.finally(() => requests.delete(binding.docId)).catch(() => {});
  }
  return request;
}

export type CanvasWidgetViewProps = {
  docId: string;
  sessionKey: string;
  messageTimestamp?: number;
  title: string;
  preferredHeight?: number;
  onHeightChange?: (height: number) => void;
  connectionGeneration: number;
  presentationActive: boolean;
  allowScripts: boolean;
};

export type OpenClawCanvasWidgetView = SolidBridgeElement<CanvasWidgetViewProps> & {
  readonly documentHtml: string | undefined;
};

class CanvasWidgetController {
  view?: CanvasDocumentViewResult;
  error = "";
  runtimeError = "";
  resourceError = false;
  contentHeight?: number;
  sandboxGeneration = 0;
  pending = false;
  private binding?: ViewBinding;
  private sandboxHost?: WidgetSandboxHost;
  private promptPort?: MessagePort;
  private sandboxOrigin = "";
  private scrollNonce = "";
  private releaseTheme?: () => void;
  private validated?: ViewBinding;
  private viewOwner?: ViewBinding;
  private retryTimer?: number;
  private slowTimer?: number;
  private retryDelayMs = 1_000;

  constructor(
    private readonly props: CanvasWidgetViewProps,
    private readonly host: HTMLElement,
    private readonly context: ApplicationContext | undefined,
    readonly notify: () => void,
  ) {}

  private clearRetry(): void {
    window.clearTimeout(this.slowTimer);
    this.slowTimer = undefined;
    window.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private scheduleRetry(binding: ViewBinding, retryAfterMs = 0): void {
    if (this.retryTimer !== undefined) {
      return;
    }
    this.pending = true;
    this.retryTimer = window.setTimeout(
      () => {
        this.retryTimer = undefined;
        if (this.isCurrent(binding)) {
          this.binding = undefined;
          this.reconcile();
          this.notify();
        }
      },
      resolveSafeTimeoutDelayMs(Math.max(this.retryDelayMs, retryAfterMs)),
    );
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, 30_000);
  }

  retireScriptPolicy(): void {
    this.clearSandbox();
    this.sandboxGeneration += 1;
    if (this.view) {
      this.error = "";
    }
  }

  get documentHtml(): string | undefined {
    return this.sameOwner(this.viewOwner) ? this.view?.html : undefined;
  }

  dispose(): void {
    window.removeEventListener("message", this.handleMessage);
    this.clearView();
  }

  connect(): void {
    window.addEventListener("message", this.handleMessage);
  }

  clearView(): void {
    this.clearRetry();
    this.validated = undefined;
    this.viewOwner = undefined;
    this.sandboxGeneration += 1;
    this.runtimeError = "";
    this.resourceError = false;
    this.binding = undefined;
    this.view = undefined;
    this.clearSandbox();
  }

  private clearSandbox(): void {
    this.scrollNonce = "";
    this.sandboxHost?.dispose();
    this.sandboxHost = undefined;
    this.promptPort?.close();
    this.promptPort = undefined;
    this.releaseTheme?.();
    this.releaseTheme = undefined;
    this.contentHeight = undefined;
  }

  private sameOwner(binding: ViewBinding | undefined): binding is ViewBinding {
    const gateway = this.context?.gateway;
    const snapshot = gateway?.snapshot;
    return Boolean(
      binding &&
      gateway &&
      snapshot &&
      binding.docId === this.props.docId &&
      binding.sessionKey === this.props.sessionKey &&
      binding.connectionRevision === gateway.connectionRevision &&
      binding.gatewayUrl === gateway.connection.gatewayUrl &&
      !snapshot.lastErrorAuthReason &&
      snapshot.phase !== "stopped" &&
      (snapshot.phase !== "connected" ||
        ((!binding.profileId ||
          !snapshot.selfUser?.id ||
          binding.profileId === snapshot.selfUser.id) &&
          binding.recoveryScope === snapshot.hello?.auth?.recoveryScope &&
          hasOperatorReadAccess(snapshot.hello?.auth ?? null))),
    );
  }

  private isCurrent(binding: ViewBinding | undefined): binding is ViewBinding {
    return (
      this.sameOwner(binding) &&
      this.host.isConnected &&
      this.binding === binding &&
      binding.client === this.context!.gateway.snapshot.client &&
      isGatewayAvailable(this.context!.gateway.snapshot) &&
      binding.generation === getCanvasWidgetFrameConnectionGeneration()
    );
  }

  reconcile(): void {
    const gateway = this.context?.gateway;
    const client = gateway?.snapshot.client;
    if (
      (this.binding && !this.sameOwner(this.binding)) ||
      (this.viewOwner && !this.sameOwner(this.viewOwner))
    ) {
      this.clearView();
    }
    if (!gateway || !client || !this.props.docId) {
      this.clearView();
      return;
    }
    // Content can outlive its socket, but prompts require a successful read in
    // the current generation. Keep the private port inert rather than remounting.
    if (!isGatewayAvailable(gateway.snapshot)) {
      this.binding = undefined;
      this.clearRetry();
      this.validated = undefined;
      this.sandboxHost?.setActive(false);
      this.pending = true;
      return;
    }
    if (!hasOperatorReadAccess(gateway.snapshot.hello?.auth ?? null)) {
      this.error = t("board.widget.sandboxUnavailable");
      return;
    }
    const profileId = gateway.snapshot.selfUser?.id;
    if (profileId) {
      if (this.binding && !this.binding.profileId) {
        this.binding.profileId = profileId;
      }
      if (this.viewOwner && !this.viewOwner.profileId) {
        this.viewOwner.profileId = profileId;
      }
    }
    const generation = getCanvasWidgetFrameConnectionGeneration();
    if (this.binding?.client === client && this.binding.generation === generation) {
      return;
    }
    this.clearRetry();
    this.validated = undefined;
    this.error = "";
    const binding: ViewBinding = {
      client,
      docId: this.props.docId,
      sessionKey: this.props.sessionKey,
      generation,
      connectionRevision: gateway.connectionRevision,
      gatewayUrl: gateway.connection.gatewayUrl,
      // Hello can omit presence until users.self settles; recoveryScope already
      // binds verified principals. Preserve known attribution until it resolves.
      profileId: gateway.snapshot.selfUser?.id ?? this.viewOwner?.profileId ?? null,
      recoveryScope: gateway.snapshot.hello?.auth?.recoveryScope,
    };
    this.binding = binding;
    this.pending = Boolean(this.view);
    this.slowTimer = window.setTimeout(() => {
      if (this.isCurrent(binding)) {
        this.pending = true;
        this.notify();
      }
    }, WIDGET_LOAD_NOTICE_MS);
    void loadCanvasView(binding)
      .then((view) => {
        if (!this.isCurrent(binding)) {
          return;
        }
        this.clearRetry();
        const previous = this.view;
        if (
          previous &&
          (previous.html !== view.html ||
            previous.sandboxUrl !== view.sandboxUrl ||
            previous.sandboxPort !== view.sandboxPort ||
            previous.sandboxOrigin !== view.sandboxOrigin)
        ) {
          this.clearSandbox();
          this.runtimeError = "";
          this.resourceError = false;
          this.sandboxGeneration += 1;
        }
        this.view = view;
        this.viewOwner = binding;
        this.validated = binding;
        this.pending = false;
        this.retryDelayMs = 1_000;
        this.sandboxHost?.setActive(this.props.presentationActive);
      })
      .catch((error: unknown) => {
        if (!this.isCurrent(binding)) {
          return;
        }
        this.clearRetry();
        if (
          isAwaitingGatewayFailure(error, gateway.snapshot) ||
          error instanceof GatewayProtocolRequestTimeoutError ||
          (error instanceof GatewayProtocolRequestError &&
            error.gatewayCode === "UNAVAILABLE" &&
            error.retryable)
        ) {
          this.scheduleRetry(
            binding,
            error instanceof GatewayProtocolRequestError ? error.retryAfterMs : undefined,
          );
          return;
        }
        // A definitive denial or missing document retires cached content and its ports.
        this.view = undefined;
        this.clearSandbox();
        this.pending = false;
        this.error = formatUiError(error);
      })
      .finally(this.notify);
  }

  syncSandbox(): void {
    const active = this.props.presentationActive && this.isCurrent(this.validated);
    this.sandboxHost?.setActive(active);
    const frame = this.host.querySelector<HTMLIFrameElement>("iframe");
    const view = this.view;
    const binding = this.binding;
    if (
      !this.props.allowScripts ||
      !frame ||
      !view ||
      !this.isCurrent(binding) ||
      this.sandboxHost
    ) {
      return;
    }
    this.sandboxOrigin = new URL(frame.src).origin;
    this.releaseTheme = registerWidgetThemeFrame(frame, this.sandboxOrigin);
    this.scrollNonce = generateUUID();
    this.sandboxHost = new WidgetSandboxHost({
      frame,
      sandboxOrigin: this.sandboxOrigin,
      sandboxUrl: frame.src,
      documentKey: `${binding.docId}\0${binding.generation}`,
      loadDocument: async () => view.html,
      onLoaded: () => {
        this.pending = false;
        this.postHostState();
        this.notify();
      },
      onRendered: () => this.postHostState(),
      onError: (error) => {
        this.clearSandbox();
        this.error = formatUiError(error);
        this.notify();
      },
      onReadyTimeout: () => {
        this.pending = true;
        this.notify();
      },
      onPending: () => {
        this.pending = true;
        this.notify();
      },
    });
    this.sandboxHost.setActive(active);
  }

  syncFrameError(): void {
    this.sandboxHost?.handleFrameError();
  }

  private postHostState(): void {
    const frame = this.sandboxHost?.frame;
    if (!frame) {
      return;
    }
    postWidgetTheme(frame, this.sandboxOrigin);
    frame.contentWindow?.postMessage({ type: "openclaw:widget-chat-host" }, this.sandboxOrigin);
    // Saved widget documents already use this bridge for unconsumed wheel/touch input.
    frame.contentWindow?.postMessage(
      { type: "openclaw:widget-board-host", nonce: this.scrollNonce },
      this.sandboxOrigin,
    );
  }

  private readonly handleMessage = (event: MessageEvent): void => {
    const host = this.sandboxHost;
    const binding = this.viewOwner;
    if (
      !host ||
      !this.host.isConnected ||
      !this.sameOwner(binding) ||
      event.source !== host.frame.contentWindow ||
      event.origin !== this.sandboxOrigin
    ) {
      return;
    }
    host.handleMessage(event);
    const data = asOptionalRecord(event.data);
    if (
      data?.type === "openclaw:widget-scroll" &&
      this.scrollNonce &&
      data.nonce === this.scrollNonce &&
      typeof data.deltaY === "number" &&
      Number.isFinite(data.deltaY)
    ) {
      forwardChatWheelToTranscript(
        new WheelEvent("wheel", { deltaY: data.deltaY, cancelable: true }),
        this.host.closest<HTMLElement>(".chat-thread"),
      );
      return;
    }
    if (data?.type === "openclaw:widget-runtime-error") {
      if (
        !this.props.presentationActive ||
        !this.props.sessionKey ||
        typeof data.message !== "string"
      ) {
        return;
      }
      // Download/rejection failures are not evidence that agent-authored code is
      // broken. Keep a local recovery action, never wake the agent to rewrite it.
      const validated = this.validated;
      if (
        !this.isCurrent(validated) ||
        !navigator.onLine ||
        /failed to fetch|load failed|networkerror|network request failed|importing a module script failed|failed to load module script/i.test(
          data.message,
        )
      ) {
        this.resourceError = true;
        this.notify();
        return;
      }
      const report = {
        message: truncateUtf16Safe(data.message, 500).toWellFormed(),
        line: typeof data.line === "number" && Number.isInteger(data.line) ? data.line : undefined,
        column:
          typeof data.column === "number" && Number.isInteger(data.column)
            ? data.column
            : undefined,
      };
      this.runtimeError ||= report.message;
      this.notify();
      const messageTimestamp = this.props.messageTimestamp;
      if (
        typeof messageTimestamp !== "number" ||
        !Number.isFinite(messageTimestamp) ||
        Date.now() - messageTimestamp > WIDGET_RUNTIME_ERROR_REPORT_WINDOW_MS
      ) {
        return;
      }
      const key = `error\0${this.props.sessionKey}\0${binding.docId}`;
      // Shared prompt limiter: 10 per key per 60 seconds, at most 100 keys.
      if (reportedRuntimeErrors.has(key) || !allowWidgetPrompt(key, Date.now())) {
        return;
      }
      reportedRuntimeErrors.add(key);
      const location =
        report.line === undefined
          ? ""
          : `, line ${report.line}${report.column === undefined ? "" : `, column ${report.column}`}`;
      const text = `Inline widget "${truncateUtf16Safe(this.props.title, 80)}" (${binding.docId}) threw a script error after rendering: ${report.message}${location}. Fix the script and show the widget again; if show_widget is unavailable in this turn, reply with the corrected widget code and show it on the next turn.`;
      void validated.client
        .request("wake", { mode: "now", sessionKey: this.props.sessionKey, text })
        .catch((error: unknown) => console.warn("Widget runtime error wake failed", error));
      return;
    }
    if (
      data?.type === "openclaw:widget-size" &&
      typeof data.height === "number" &&
      Number.isFinite(data.height) &&
      data.height > 0
    ) {
      this.contentHeight = Math.min(8000, Math.max(48, Math.trunc(data.height)));
      this.props.onHeightChange?.(this.contentHeight);
      this.notify();
    }
    if (data?.type === "openclaw:widget-bridge-ready") {
      this.postHostState();
    }
    if (data?.type !== "openclaw:widget-prompt-offer") {
      if (data?.type === "openclaw:widget-bridge-port-offer") {
        event.ports[0]?.close();
      }
      return;
    }
    const port = event.ports[0];
    if (!port || this.promptPort || !host.loaded) {
      port?.close();
      return;
    }
    // The isolated proxy forwards only the wrapper's first offer. Inline views
    // adopt its prompt channel only; pinning never lends them dashboard grants.
    this.promptPort = port;
    port.addEventListener("message", (message: MessageEvent) => {
      if (
        this.props.presentationActive &&
        this.isCurrent(this.validated) &&
        this.sandboxHost === host &&
        this.promptPort === port &&
        message.data?.type === "openclaw:widget-prompt"
      ) {
        void dispatchWidgetPrompt(
          host.frame,
          message.data.prompt,
          `${this.props.sessionKey}\0${this.props.docId}\0${this.validated!.generation}`,
        );
      }
    });
    port.start();
    port.postMessage({ type: "openclaw:widget-prompt-host-ready" });
  };
}

export const CanvasWidgetView = defineSolidBridge<CanvasWidgetViewProps>(
  "openclaw-canvas-widget-view",
  (props, host) => {
    host.style.display = "contents";
    const context = useApplication();
    const [revision, setRevision] = createSignal(0, { ownedWrite: true });
    const [gatewayRevision, setGatewayRevision] = createSignal(0, { ownedWrite: true });
    const controller = new CanvasWidgetController(host, host, context, () =>
      setRevision((n) => n + 1),
    );
    const scriptProperty = Object.getOwnPropertyDescriptor(host, "allowScripts")!;
    // Even a false→true change within one commit must revoke the old private port.
    Object.defineProperty(host, "allowScripts", {
      ...scriptProperty,
      set(value: boolean) {
        if (value !== host.allowScripts) {
          controller.retireScriptPolicy();
        }
        scriptProperty.set!.call(host, value);
        controller.notify();
      },
    });
    const read = () => {
      revision();
      return controller;
    };
    Object.defineProperty(host, "documentHtml", {
      configurable: true,
      get: () => controller.documentHtml,
    });
    const unsubscribe = context?.gateway.subscribe(() => setGatewayRevision((n) => n + 1));
    createRenderEffect(
      () => [
        props.docId,
        props.sessionKey,
        props.connectionGeneration,
        props.allowScripts,
        props.presentationActive,
        gatewayRevision(),
      ],
      () => {
        controller.reconcile();
        controller.notify();
      },
    );
    createEffect(
      () => [revision(), props.presentationActive],
      () => controller.syncSandbox(),
    );
    onSettled(() => controller.connect());
    onCleanup(() => {
      Object.defineProperty(host, "allowScripts", scriptProperty);
      unsubscribe?.();
      controller.dispose();
    });
    const retry = () => {
      controller.clearView();
      controller.reconcile();
      controller.notify();
    };
    const source = createMemo(() => {
      const view = read().view;
      if (!view || !context) {
        return undefined;
      }
      try {
        return {
          src: props.allowScripts
            ? resolveSandboxHostUrl(
                view.sandboxUrl,
                view.sandboxPort,
                view.sandboxOrigin,
                context.gateway.connection.gatewayUrl,
                window.location.origin,
              )
            : undefined,
        };
      } catch (error) {
        return { error: formatUiError(error) };
      }
    });
    const height = () => read().contentHeight ?? props.preferredHeight ?? 420;
    return (
      <Show
        when={!read().error}
        fallback={
          <div class="board-widget__error" role="alert">
            {read().error}
            <button class="btn btn--small" onClick={retry}>
              {t("common.retry")}
            </button>
          </div>
        }
      >
        <Show
          when={Boolean(source())}
          fallback={
            <Show
              when={read().pending}
              fallback={
                <div
                  class="skeleton"
                  role="status"
                  aria-label={t("common.loading")}
                  style={{ "min-height": `${height()}px` }}
                />
              }
            >
              <div
                class="board-widget__notice"
                role="status"
                style={{ "min-height": `${height()}px` }}
              >
                {t("board.widget.waitingForConnection")}
              </div>
            </Show>
          }
        >
          <Show when={!source()?.error} fallback={<div role="alert">{source()?.error}</div>}>
            <Show when={read().pending}>
              <div class="board-widget__notice" role="status">
                {t("board.widget.waitingForConnection")}
              </div>
            </Show>
            <Show when={read().resourceError}>
              <div class="board-widget__notice" role="status">
                {t("board.widget.resourceUnavailable")}
                <button class="btn btn--small" onClick={retry}>
                  {t("common.retry")}
                </button>
              </div>
            </Show>
            <Show when={read().runtimeError}>
              <div class="board-widget__notice" role="status">
                {t("board.widget.runtimeError", { message: read().runtimeError })}
              </div>
            </Show>
            <Show when={String(read().sandboxGeneration)} keyed>
              {(_generation) => (
                <iframe
                  class="chat-tool-card__preview-frame"
                  allow="fullscreen"
                  title={props.title}
                  src={source()?.src}
                  srcdoc={props.allowScripts ? undefined : read().view?.html}
                  sandbox={props.allowScripts ? "allow-scripts allow-same-origin allow-forms" : ""}
                  referrerpolicy="origin"
                  style={{
                    height: height() ? `${height()}px` : undefined,
                    "min-height": height() ? `${height()}px` : undefined,
                  }}
                  onError={() => controller.syncFrameError()}
                />
              )}
            </Show>
          </Show>
        </Show>
      </Show>
    );
  },
  {
    properties: {
      docId: { default: "" },
      sessionKey: { default: "" },
      messageTimestamp: { default: undefined, type: Number },
      title: { default: "" },
      preferredHeight: { default: undefined, type: Number },
      onHeightChange: { default: undefined, attribute: false },
      connectionGeneration: { default: 0 },
      presentationActive: { default: true },
      allowScripts: { default: true },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-canvas-widget-view": OpenClawCanvasWidgetView;
  }
}
