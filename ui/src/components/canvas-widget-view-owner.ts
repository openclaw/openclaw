import {
  GatewayProtocolRequestError,
  GatewayProtocolRequestTimeoutError,
  resolveSafeTimeoutDelayMs,
} from "@openclaw/gateway-client/browser";
import type { CanvasDocumentViewResult } from "@openclaw/gateway-protocol";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { ApplicationContext } from "../app/context.ts";
import { hasOperatorReadAccess, hasOperatorSelfReadAccess } from "../app/operator-access.ts";
import { getCanvasWidgetFrameConnectionGeneration } from "../lib/chat/canvas-widget-frame-generation.ts";
import { formatUiError } from "../lib/format-error.ts";
import { isAwaitingGatewayFailure, isGatewayAvailable } from "../lib/gateway-availability.ts";
import { t } from "../lib/reactive/i18n.ts";
import { listen } from "../lib/reactive/listener.ts";
import { observeWindowMessage } from "../lib/reactive/window-message.ts";
import { generateUUID } from "../lib/uuid.ts";
import { WidgetSandboxHost, WIDGET_LOAD_NOTICE_MS } from "../lib/widget-sandbox-host.ts";
import { registerWidgetThemeFrame, postWidgetTheme } from "../lib/widget-theme.ts";
import { forwardChatWheelToTranscript } from "../pages/chat/chat-scroll-input.ts";
import {
  createCanvasWidgetViewLoader,
  isCanvasWidgetLoadRetryEvent,
  type CanvasWidgetViewBinding,
} from "./canvas-widget-view-loader.ts";
import { allowWidgetPrompt, dispatchWidgetPrompt } from "./mcp-app-security.ts";

type ViewBinding = CanvasWidgetViewBinding & {
  connectionRevision: number;
  gatewayUrl: string;
  profileId: string | null;
  recoveryScope: string | undefined;
};
// One wake attempt per session/document per page load, including remounts.
const reportedRuntimeErrors = new Set<string>();
// Fresh renders ping the agent; old restored history only shows the notice.
const WIDGET_RUNTIME_ERROR_REPORT_WINDOW_MS = 10 * 60_000;

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

export function createCanvasWidget(
  props: CanvasWidgetViewProps,
  element: HTMLElement,
  context: ApplicationContext,
  notify: () => void,
) {
  const loader = createCanvasWidgetViewLoader(context.sessions);
  // Document identity and private-port authority stay synchronous; the view reads a projection.
  const state: {
    view?: CanvasDocumentViewResult;
    error: string;
    accessDenied: boolean;
    awaitingResult: boolean;
    runtimeError: string;
    resourceError: boolean;
    contentHeight?: number;
    sandboxGeneration: number;
    pending: boolean;
  } = {
    error: "",
    accessDenied: false,
    awaitingResult: false,
    runtimeError: "",
    resourceError: false,
    sandboxGeneration: 0,
    pending: false,
  };
  let activeBinding: ViewBinding | undefined;
  let sandboxHost: WidgetSandboxHost | undefined;
  let promptPort: MessagePort | undefined;
  let releasePromptPort: (() => void) | undefined;
  let frameElement: HTMLIFrameElement | undefined;
  let sandboxOrigin = "";
  let scrollNonce = "";
  let releaseTheme: (() => void) | undefined;
  let releaseMessages: (() => void) | undefined;
  let stopRetryEvents: (() => void) | undefined;
  let validatedBinding: ViewBinding | undefined;
  let ownerBinding: ViewBinding | undefined;
  let retryTimer: number | undefined;
  let slowTimer: number | undefined;
  let retryDelayMs = 1_000;
  Object.defineProperties(element, {
    documentHtml: {
      configurable: true,
      get: () => (sameOwner(ownerBinding) ? state.view?.html : undefined),
    },
    previewFrame: {
      configurable: true,
      get: () => (frameElement?.isConnected ? frameElement : undefined),
    },
  });
  function clearRetry(): void {
    window.clearTimeout(slowTimer);
    slowTimer = undefined;
    window.clearTimeout(retryTimer);
    retryTimer = undefined;
  }

  function releaseRetryEvents(): void {
    stopRetryEvents?.();
    stopRetryEvents = undefined;
  }

  function watchRetryEvents(binding: ViewBinding): void {
    if (binding.operatorRead || state.view || stopRetryEvents || !isCurrent(binding)) {
      return;
    }
    stopRetryEvents = context.gateway.subscribeEvents((event) => {
      if (!isCurrent(binding) || state.view || !isCanvasWidgetLoadRetryEvent(event, binding)) {
        return;
      }
      // Retire an in-flight pre-commit lookup too; a remount must not borrow its stale miss.
      loader.forget(binding);
      releaseRetryEvents();
      activeBinding = undefined;
      reconcile();
      notify();
    });
  }

  function scheduleRetry(binding: ViewBinding, retryAfterMs = 0): void {
    if (retryTimer !== undefined) {
      return;
    }
    state.pending = true;
    retryTimer = window.setTimeout(
      () => {
        retryTimer = undefined;
        if (isCurrent(binding)) {
          releaseRetryEvents();
          activeBinding = undefined;
          reconcile();
          notify();
        }
      },
      resolveSafeTimeoutDelayMs(Math.max(retryDelayMs, retryAfterMs)),
    );
    retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
  }

  function retireScriptPolicy(): void {
    clearSandbox();
    state.sandboxGeneration += 1;
    if (state.view) {
      state.error = "";
    }
  }

  function clearView(): void {
    releaseRetryEvents();
    loader.forget(activeBinding);
    loader.release();
    clearRetry();
    state.awaitingResult = false;
    validatedBinding = undefined;
    ownerBinding = undefined;
    state.sandboxGeneration += 1;
    state.runtimeError = "";
    state.resourceError = false;
    activeBinding = undefined;
    state.view = undefined;
    clearSandbox();
  }

  function clearSandbox(): void {
    scrollNonce = "";
    sandboxHost?.dispose();
    sandboxHost = undefined;
    releaseMessages?.();
    releaseMessages = undefined;
    releasePromptPort?.();
    releasePromptPort = undefined;
    promptPort?.close();
    promptPort = undefined;
    releaseTheme?.();
    releaseTheme = undefined;
    state.contentHeight = undefined;
  }

  function sameOwner(binding: ViewBinding | undefined): binding is ViewBinding {
    const gateway = context.gateway;
    const snapshot = gateway?.snapshot;
    return Boolean(
      binding &&
      gateway &&
      snapshot &&
      binding.docId === props.docId &&
      binding.sessionKey === props.sessionKey &&
      binding.connectionRevision === gateway.connectionRevision &&
      binding.gatewayUrl === gateway.connection.gatewayUrl &&
      !snapshot.lastErrorAuthReason &&
      snapshot.phase !== "stopped" &&
      (snapshot.phase !== "connected" ||
        ((!binding.profileId ||
          !snapshot.selfUser?.id ||
          binding.profileId === snapshot.selfUser.id) &&
          binding.recoveryScope === snapshot.hello?.auth?.recoveryScope &&
          binding.operatorRead === hasOperatorReadAccess(snapshot.hello?.auth ?? null) &&
          hasOperatorSelfReadAccess(snapshot.hello?.auth ?? null))),
    );
  }

  function isCurrent(binding: ViewBinding | undefined): binding is ViewBinding {
    return (
      sameOwner(binding) &&
      element.isConnected &&
      activeBinding === binding &&
      binding.client === context.gateway.snapshot.client &&
      isGatewayAvailable(context.gateway.snapshot) &&
      binding.generation === getCanvasWidgetFrameConnectionGeneration()
    );
  }

  function reconcile(): void {
    const gateway = context.gateway;
    const client = gateway?.snapshot.client;
    if (
      (activeBinding && !sameOwner(activeBinding)) ||
      (ownerBinding && !sameOwner(ownerBinding))
    ) {
      clearView();
    }
    if (!gateway || !client || !props.docId) {
      clearView();
      return;
    }
    // Content can outlive its socket, but prompts require a successful read in
    // the current generation. Keep the private port inert rather than remounting.
    if (!isGatewayAvailable(gateway.snapshot)) {
      releaseRetryEvents();
      activeBinding = undefined;
      loader.release();
      clearRetry();
      validatedBinding = undefined;
      sandboxHost?.setActive(false);
      state.awaitingResult = false;
      state.pending = true;
      return;
    }
    if (!hasOperatorSelfReadAccess(gateway.snapshot.hello?.auth ?? null)) {
      state.accessDenied = true;
      state.error = t("board.widget.accessDenied");
      return;
    }
    const profileId = gateway.snapshot.selfUser?.id;
    if (profileId) {
      if (activeBinding && !activeBinding.profileId) {
        activeBinding.profileId = profileId;
      }
      if (ownerBinding && !ownerBinding.profileId) {
        ownerBinding.profileId = profileId;
      }
    }
    const generation = getCanvasWidgetFrameConnectionGeneration();
    if (activeBinding?.client === client && activeBinding.generation === generation) {
      return;
    }
    clearRetry();
    releaseRetryEvents();
    validatedBinding = undefined;
    state.error = "";
    state.accessDenied = false;
    const binding: ViewBinding = {
      client,
      docId: props.docId,
      sessionKey: props.sessionKey,
      generation,
      connectionRevision: gateway.connectionRevision,
      gatewayUrl: gateway.connection.gatewayUrl,
      // Hello can omit presence until users.self settles; recoveryScope already
      // binds verified principals. Preserve known attribution until it resolves.
      profileId: gateway.snapshot.selfUser?.id ?? ownerBinding?.profileId ?? null,
      recoveryScope: gateway.snapshot.hello?.auth?.recoveryScope,
      operatorRead: hasOperatorReadAccess(gateway.snapshot.hello?.auth ?? null),
    };
    activeBinding = binding;
    watchRetryEvents(binding);
    state.pending = Boolean(state.view) || state.awaitingResult;
    slowTimer = window.setTimeout(() => {
      if (isCurrent(binding)) {
        state.pending = true;
        notify();
      }
    }, WIDGET_LOAD_NOTICE_MS);
    void loader
      .load(binding, () => isCurrent(binding))
      .then((view) => {
        if (!view || !isCurrent(binding)) {
          return;
        }
        loader.release();
        clearRetry();
        const previous = state.view;
        if (
          previous &&
          (previous.html !== view.html ||
            previous.sandboxUrl !== view.sandboxUrl ||
            previous.sandboxPort !== view.sandboxPort ||
            previous.sandboxOrigin !== view.sandboxOrigin)
        ) {
          clearSandbox();
          state.runtimeError = "";
          state.resourceError = false;
          state.sandboxGeneration += 1;
        }
        state.view = view;
        releaseRetryEvents();
        ownerBinding = binding;
        validatedBinding = binding;
        state.pending = false;
        state.awaitingResult = false;
        retryDelayMs = 1_000;
        sandboxHost?.setActive(props.presentationActive);
      })
      .catch((error: unknown) => {
        if (!isCurrent(binding)) {
          return;
        }
        clearRetry();
        state.awaitingResult =
          error instanceof GatewayProtocolRequestError &&
          asOptionalRecord(error.details)?.type === "canvas_widget_pending";
        if (
          isAwaitingGatewayFailure(error, gateway.snapshot) ||
          error instanceof GatewayProtocolRequestTimeoutError ||
          (error instanceof GatewayProtocolRequestError &&
            error.gatewayCode === "UNAVAILABLE" &&
            error.retryable)
        ) {
          scheduleRetry(
            binding,
            error instanceof GatewayProtocolRequestError ? error.retryAfterMs : undefined,
          );
          return;
        }
        // A definitive denial or missing document retires cached content and its ports.
        state.view = undefined;
        clearSandbox();
        state.pending = false;
        state.accessDenied =
          error instanceof GatewayProtocolRequestError && error.gatewayCode === "FORBIDDEN";
        state.error = formatUiError(error);
        watchRetryEvents(binding);
      })
      .finally(notify);
  }

  function syncSandbox(): void {
    const active = props.presentationActive && isCurrent(validatedBinding);
    sandboxHost?.setActive(active);
    const frame = frameElement;
    const view = state.view;
    const binding = activeBinding;
    if (!props.allowScripts || !frame?.isConnected || !view || !isCurrent(binding) || sandboxHost) {
      return;
    }
    sandboxOrigin = new URL(frame.src).origin;
    releaseTheme = registerWidgetThemeFrame(frame, sandboxOrigin);
    scrollNonce = generateUUID();
    releaseMessages = observeWindowMessage(window, frame.contentWindow!, handleMessage);
    sandboxHost = new WidgetSandboxHost({
      frame,
      sandboxOrigin,
      sandboxUrl: frame.src,
      documentKey: `${binding.docId}\0${binding.generation}`,
      loadDocument: async () => view.html,
      onLoaded: () => {
        state.pending = false;
        postHostState();
        notify();
      },
      onRendered: postHostState,
      onError: (error) => {
        clearSandbox();
        state.error = formatUiError(error);
        notify();
      },
      onReadyTimeout: () => {
        state.pending = true;
        notify();
      },
      onPending: () => {
        state.pending = true;
        notify();
      },
    });
    sandboxHost.setActive(active);
  }

  function syncFrameError(): void {
    sandboxHost?.handleFrameError();
  }

  function postHostState(): void {
    const frame = sandboxHost?.frame;
    if (!frame) {
      return;
    }
    postWidgetTheme(frame, sandboxOrigin);
    frame.contentWindow?.postMessage({ type: "openclaw:widget-chat-host" }, sandboxOrigin);
    // Saved widget documents use this bridge for unconsumed wheel input.
    frame.contentWindow?.postMessage(
      { type: "openclaw:widget-board-host", nonce: scrollNonce },
      sandboxOrigin,
    );
  }

  const handleMessage = (event: Event): void => {
    const host = sandboxHost;
    const binding = ownerBinding;
    if (
      !(event instanceof MessageEvent) ||
      !host ||
      !element.isConnected ||
      !sameOwner(binding) ||
      event.source !== host.frame.contentWindow ||
      event.origin !== sandboxOrigin
    ) {
      return;
    }
    host.handleMessage(event);
    const data = asOptionalRecord(event.data);
    if (
      data?.type === "openclaw:widget-scroll" &&
      scrollNonce &&
      data.nonce === scrollNonce &&
      typeof data.deltaY === "number" &&
      Number.isFinite(data.deltaY)
    ) {
      forwardChatWheelToTranscript(
        new WheelEvent("wheel", { deltaY: data.deltaY, cancelable: true }),
        element.closest<HTMLElement>(".chat-thread"),
      );
      return;
    }
    if (data?.type === "openclaw:widget-runtime-error") {
      if (!props.presentationActive || !props.sessionKey || typeof data.message !== "string") {
        return;
      }
      // Download/rejection failures are not evidence that agent-authored code is
      // broken. Keep a local recovery action, never wake the agent to rewrite it.
      const validated = validatedBinding;
      if (
        !isCurrent(validated) ||
        !navigator.onLine ||
        /failed to fetch|load failed|networkerror|network request failed|importing a module script failed|failed to load module script/i.test(
          data.message,
        )
      ) {
        state.resourceError = true;
        notify();
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
      state.runtimeError ||= report.message;
      notify();
      const messageTimestamp = props.messageTimestamp;
      if (
        typeof messageTimestamp !== "number" ||
        !Number.isFinite(messageTimestamp) ||
        Date.now() - messageTimestamp > WIDGET_RUNTIME_ERROR_REPORT_WINDOW_MS
      ) {
        return;
      }
      const key = `error\0${props.sessionKey}\0${binding.docId}`;
      // Shared prompt limiter: 10 per key per 60 seconds, at most 100 keys.
      if (reportedRuntimeErrors.has(key) || !allowWidgetPrompt(key, Date.now())) {
        return;
      }
      reportedRuntimeErrors.add(key);
      const location =
        report.line === undefined
          ? ""
          : `, line ${report.line}${report.column === undefined ? "" : `, column ${report.column}`}`;
      const text = `Inline widget "${truncateUtf16Safe(props.title, 80)}" (${binding.docId}) threw a script error after rendering: ${report.message}${location}. Fix the script and show the widget again; if show_widget is unavailable in this turn, reply with the corrected widget code and show it on the next turn.`;
      void validated.client
        .request("wake", { mode: "now", sessionKey: props.sessionKey, text })
        .catch((error: unknown) => console.warn("Widget runtime error wake failed", error));
      return;
    }
    if (
      data?.type === "openclaw:widget-size" &&
      typeof data.height === "number" &&
      Number.isFinite(data.height) &&
      data.height > 0
    ) {
      state.contentHeight = Math.min(8000, Math.max(48, Math.trunc(data.height)));
      props.onHeightChange?.(state.contentHeight);
      notify();
    }
    if (data?.type === "openclaw:widget-bridge-ready") {
      postHostState();
    }
    if (data?.type !== "openclaw:widget-prompt-offer") {
      if (data?.type === "openclaw:widget-bridge-port-offer") {
        event.ports[0]?.close();
      }
      return;
    }
    const port = event.ports[0];
    if (!port || promptPort || !host.loaded) {
      port?.close();
      return;
    }
    // The isolated proxy forwards only the wrapper's first offer. Inline views
    // adopt its prompt channel only; pinning never lends them dashboard grants.
    promptPort = port;
    releasePromptPort = listen(port, "message", (message) => {
      if (
        message instanceof MessageEvent &&
        props.presentationActive &&
        isCurrent(validatedBinding) &&
        sandboxHost === host &&
        promptPort === port &&
        message.data?.type === "openclaw:widget-prompt"
      ) {
        void dispatchWidgetPrompt(
          host.frame,
          message.data.prompt,
          `${props.sessionKey}\0${props.docId}\0${validatedBinding!.generation}`,
        );
      }
    });
    port.start();
    port.postMessage({ type: "openclaw:widget-prompt-host-ready" });
  };
  return {
    state,
    notify,
    reconcile,
    retireScriptPolicy,
    clearView,
    syncSandbox,
    syncFrameError,
    setFrame: (frame: HTMLIFrameElement) => {
      frameElement = frame;
    },
  };
}
