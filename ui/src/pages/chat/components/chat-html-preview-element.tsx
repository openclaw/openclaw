import type {
  CanvasDocumentViewResult,
  SessionsFilesAssetsResult,
} from "@openclaw/gateway-protocol";
import { Show, createEffect, createMemo, createSignal, onCleanup, onSettled } from "solid-js";
import type { ApplicationContext } from "../../../app/context.ts";
import { resolveSandboxHostUrl } from "../../../components/sandbox-host.ts";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import { getCanvasWidgetFrameConnectionGeneration } from "../../../lib/chat/canvas-widget-frame-generation.ts";
import type { EmbedSandboxMode } from "../../../lib/chat/tool-display.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { projectGateway } from "../../../lib/reactive/application.ts";
import { useApplication } from "../../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import { WidgetSandboxHost, WIDGET_LOAD_TIMEOUT_MS } from "../../../lib/widget-sandbox-host.ts";
import { prepareHtmlPreviewAssets } from "./chat-html-preview-assets.ts";
import { prepareHtmlPreviewLinks } from "./chat-html-preview-links.ts";
import type { SessionFileSource } from "./chat-sidebar-content-types.ts";

registerEnglishCatalog(registerFilePreviewEnglish);

type HtmlPreviewProps = {
  html: string;
  sourceIdentity: string;
  sessionFileSource?: SessionFileSource;
  title: string;
  embedSandboxMode: EmbedSandboxMode;
};
export type ChatHtmlPreviewElement = SolidBridgeElement<HtmlPreviewProps>;

type PreviewBinding = {
  client: NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
  generation: number;
  html: string;
  sourceIdentity: string;
  sessionFileSource?: SessionFileSource;
};

type PreviewView = {
  document: CanvasDocumentViewResult;
  binding: PreviewBinding;
  url: string;
  origin: string;
};

/** Only transfers document bytes. Ordinary files never receive widget host APIs. */
export const ChatHtmlPreview = defineSolidBridge<HtmlPreviewProps>(
  "openclaw-chat-html-preview",
  (props, host) => {
    const context = useApplication();
    const gateway = context && projectGateway(context.gateway);
    const [view, setView] = createSignal<PreviewView>();
    const [error, setError] = createSignal("");
    const [retry, setRetry] = createSignal(0);
    const frameMode = createMemo(() => props.embedSandboxMode);
    let binding: PreviewBinding | undefined;
    let sandboxHost: WidgetSandboxHost | undefined;
    let frameGeneration = 0;
    let disposed = false;

    const isCurrent = (candidate: PreviewBinding | undefined): candidate is PreviewBinding =>
      Boolean(
        candidate &&
        !disposed &&
        host.isConnected &&
        binding === candidate &&
        context?.gateway.snapshot.phase === "connected" &&
        context.gateway.snapshot.client === candidate.client &&
        candidate.generation === getCanvasWidgetFrameConnectionGeneration() &&
        candidate.html === host.html &&
        candidate.sourceIdentity === host.sourceIdentity &&
        candidate.sessionFileSource?.sessionKey === host.sessionFileSource?.sessionKey &&
        candidate.sessionFileSource?.agentId === host.sessionFileSource?.agentId &&
        candidate.sessionFileSource?.path === host.sessionFileSource?.path,
      );

    // Bind the external preview RPC to the live Gateway and document identity.
    createEffect(
      () => [
        props.html,
        props.sourceIdentity,
        props.sessionFileSource?.sessionKey,
        props.sessionFileSource?.agentId,
        props.sessionFileSource?.path,
        gateway?.read(),
        retry(),
      ],
      () => {
        if (isCurrent(binding)) {
          return;
        }
        sandboxHost?.dispose();
        sandboxHost = undefined;
        binding = undefined;
        setView(undefined);
        const client = context?.gateway.snapshot.client;
        if (!context || !client || context.gateway.snapshot.phase !== "connected") {
          setError(t("chat.attachments.previewUnavailable"));
          return;
        }
        const current: PreviewBinding = {
          client,
          html: host.html,
          sourceIdentity: host.sourceIdentity,
          sessionFileSource: host.sessionFileSource && { ...host.sessionFileSource },
          generation: getCanvasWidgetFrameConnectionGeneration(),
        };
        binding = current;
        setError("");
        void client
          .request<CanvasDocumentViewResult>(
            "canvas.document.preview",
            { html: current.html },
            { timeoutMs: WIDGET_LOAD_TIMEOUT_MS },
          )
          .then((document) => {
            if (!isCurrent(current)) {
              return;
            }
            const url = resolveSandboxHostUrl(
              document.sandboxUrl,
              document.sandboxPort,
              document.sandboxOrigin,
              context.gateway.connection.gatewayUrl,
              window.location.origin,
            );
            setView({ document, binding: current, url, origin: new URL(url).origin });
          })
          .catch((reason: unknown) => {
            if (isCurrent(current)) {
              setError(formatUiError(reason));
            }
          });
      },
    );
    onCleanup(() => {
      disposed = true;
      binding = undefined;
      sandboxHost?.dispose();
      sandboxHost = undefined;
    });

    const ErrorNotice = (notice: { message: string }) => (
      <div class="chat-html-preview__error" role="alert">
        {notice.message}
        <button
          class="btn btn--sm"
          type="button"
          onClick={() => {
            binding = undefined;
            setRetry((value) => value + 1);
          }}
        >
          {t("common.retry")}
        </button>
      </div>
    );

    // The keyed branches pass plain identity values and own all transport presentation state.
    const renderFrame = (preview: PreviewView, mode: EmbedSandboxMode) => {
      const [frameError, setFrameError] = createSignal("");
      const [rendered, setRendered] = createSignal(false);
      const [omittedAssets, setOmittedAssets] = createSignal(0);
      const generation = ++frameGeneration;
      let frame!: HTMLIFrameElement;
      let transport: WidgetSandboxHost | undefined;
      const currentFrame = () =>
        isCurrent(preview.binding) && host.embedSandboxMode === mode && sandboxHost === transport;
      const release = () => {
        transport?.dispose();
        if (sandboxHost === transport) {
          sandboxHost = undefined;
        }
      };
      const fail = (reason: unknown) => {
        if (currentFrame()) {
          release();
          setFrameError(formatUiError(reason));
        }
      };
      onSettled(() => {
        const allowScripts = mode !== "strict";
        transport = new WidgetSandboxHost({
          frame,
          sandboxUrl: preview.url,
          sandboxOrigin: preview.origin,
          documentKey: String(generation),
          allowScripts,
          loadDocument: async () => {
            let content = prepareHtmlPreviewLinks(preview.document.html, allowScripts);
            const source = preview.binding.sessionFileSource;
            if (source) {
              const prepared = await prepareHtmlPreviewAssets(content, allowScripts, (refs) => {
                if (!currentFrame()) {
                  throw new DOMException("Preview changed", "AbortError");
                }
                return preview.binding.client.request<SessionsFilesAssetsResult>(
                  "sessions.files.assets",
                  { ...source, refs },
                );
              });
              if (currentFrame()) {
                setOmittedAssets(prepared.omitted);
              }
              content = prepared.html;
            }
            return content;
          },
          onLoaded: () => {},
          onRendered: () => {
            if (currentFrame()) {
              setRendered(true);
            }
          },
          onError: fail,
          // Only Retry creates another transport after an unavailable proxy or render timeout.
          onReadyTimeout: () => fail(new Error(t("board.widget.sandboxUnavailable"))),
        });
        sandboxHost = transport;
        const stopMessages = listen(window, "message", (event) => {
          if (!(event instanceof MessageEvent) || event.source !== frame.contentWindow) {
            return;
          }
          // Close this frame's unsupported ports without interfering with sibling widgets.
          for (const port of event.ports) {
            port.close();
          }
          if (currentFrame() && event.origin === new URL(frame.src).origin) {
            transport?.handleMessage(event);
          }
        });
        return () => {
          stopMessages();
          release();
        };
      });
      return (
        <Show when={!frameError()} fallback={<ErrorNotice message={frameError()} />}>
          <Show when={omittedAssets()}>
            <div class="file-view__save-notice" role="status">
              {t("chat.detailPanel.assetsUnavailable", { count: String(omittedAssets()) })}
            </div>
          </Show>
          <Show when={!rendered()}>
            <div role="status">{t("common.loading")}</div>
          </Show>
          <iframe
            ref={(element) => (frame = element)}
            class="chat-html-preview__frame"
            title={props.title}
            src={preview.url}
            sandbox="allow-scripts allow-same-origin allow-forms"
            referrerpolicy="origin"
            onError={() => fail(new Error(t("board.widget.sandboxUnavailable")))}
          />
        </Show>
      );
    };

    return (
      <Show when={!error()} fallback={<ErrorNotice message={error()} />}>
        <Show when={view()} keyed fallback={<div role="status">{t("common.loading")}</div>}>
          {(preview) => (
            <Show when={frameMode()} keyed>
              {(mode) => renderFrame(preview, mode)}
            </Show>
          )}
        </Show>
      </Show>
    );
  },
  {
    properties: {
      html: { default: "", attribute: false },
      sourceIdentity: { default: "" },
      sessionFileSource: { default: undefined, attribute: false },
      title: { default: "" },
      embedSandboxMode: { default: "scripts" },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-html-preview": ChatHtmlPreviewElement;
  }
}
