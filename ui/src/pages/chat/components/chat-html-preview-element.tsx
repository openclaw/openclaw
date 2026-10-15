import type {
  CanvasDocumentViewResult,
  SessionsFilesAssetsResult,
} from "@openclaw/gateway-protocol";
import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  runWithOwner,
  untrack,
} from "solid-js";
import type { ApplicationContext } from "../../../app/context.ts";
import { resolveSandboxHostUrl } from "../../../components/sandbox-host.ts";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import { getCanvasWidgetFrameConnectionGeneration } from "../../../lib/chat/canvas-widget-frame-generation.ts";
import type { EmbedSandboxMode } from "../../../lib/chat/tool-display.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { projectGateway } from "../../../lib/reactive/application.ts";
import { useApplication } from "../../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { WidgetSandboxHost, WIDGET_LOAD_TIMEOUT_MS } from "../../../lib/widget-sandbox-host.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lit/solid-bridge.ts";
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
    const [rendered, setRendered] = createSignal(false);
    const [omittedAssets, setOmittedAssets] = createSignal(0);
    const [retry, setRetry] = createSignal(0);
    const frameMode = createMemo(() => ({ mode: props.embedSandboxMode }), {
      equals: (previous, next) => previous.mode === next.mode,
    });
    let binding: PreviewBinding | undefined;
    let sandboxHost: WidgetSandboxHost | undefined;
    let frameGeneration = 0;
    let transportMode: EmbedSandboxMode | undefined;
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

    // Nested bridge effects may flush while the Solid caller still owns the render stack.
    const clearSandbox = () =>
      runWithOwner(null, () => {
        sandboxHost?.dispose();
        sandboxHost = undefined;
        setRendered(false);
        setOmittedAssets(0);
      });
    const fail = (reason: unknown) => {
      clearSandbox();
      setError(formatUiError(reason));
    };

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
      () =>
        runWithOwner(null, () => {
          if (isCurrent(binding)) {
            return;
          }
          clearSandbox();
          binding = undefined;
          setView(undefined);
          const client = context?.gateway.snapshot.client;
          if (!context || !client || context.gateway.snapshot.phase !== "connected") {
            setError(untrack(() => t("chat.attachments.previewUnavailable")));
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
                fail(reason);
              }
            });
        }),
    );

    createEffect(frameMode, () =>
      runWithOwner(null, () => {
        if (untrack(view)) {
          clearSandbox();
          setError("");
        }
      }),
    );

    const handleMessage = (event: MessageEvent) => {
      const transport = sandboxHost;
      if (!transport || event.source !== transport.frame.contentWindow) {
        return;
      }
      // Close this frame's unsupported ports without interfering with sibling widgets.
      for (const port of event.ports) {
        port.close();
      }
      if (
        !isCurrent(binding) ||
        event.origin !== new URL(transport.frame.src).origin ||
        host.embedSandboxMode !== transportMode
      ) {
        return;
      }
      transport.handleMessage(event);
    };
    window.addEventListener("message", handleMessage);
    onCleanup(() => {
      disposed = true;
      binding = undefined;
      window.removeEventListener("message", handleMessage);
      clearSandbox();
    });

    const Frame = (frameProps: { preview: PreviewView; mode: EmbedSandboxMode }) => {
      const preview = untrack(() => frameProps.preview);
      const mode = untrack(() => frameProps.mode);
      const generation = ++frameGeneration;
      let frame!: HTMLIFrameElement;
      let transport: WidgetSandboxHost | undefined;
      const currentFrame = () =>
        isCurrent(preview.binding) && host.embedSandboxMode === mode && sandboxHost === transport;
      const frameError = (reason: unknown) => {
        if (currentFrame()) {
          fail(reason);
        }
      };
      createEffect(
        () => frame,
        () => {
          clearSandbox();
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
            onError: frameError,
            // Only Retry creates another transport after an unavailable proxy or render timeout.
            onReadyTimeout: () => frameError(new Error(t("board.widget.sandboxUnavailable"))),
          });
          sandboxHost = transport;
          transportMode = mode;
          return () => {
            transport?.dispose();
            if (sandboxHost === transport) {
              sandboxHost = undefined;
            }
          };
        },
      );
      return (
        <iframe
          ref={(element) => {
            frame = element;
          }}
          class="chat-html-preview__frame"
          title={props.title}
          src={preview.url}
          sandbox="allow-scripts allow-same-origin allow-forms"
          referrerpolicy="origin"
          onError={() => frameError(new Error(t("board.widget.sandboxUnavailable")))}
        />
      );
    };

    return (
      <Show
        when={!error()}
        fallback={
          <div class="chat-html-preview__error" role="alert">
            {error()}
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
        }
      >
        <Show when={omittedAssets()}>
          <div class="file-view__save-notice" role="status">
            {t("chat.detailPanel.assetsUnavailable", { count: String(omittedAssets()) })}
          </div>
        </Show>
        <Show when={!rendered()}>
          <div role="status">{t("common.loading")}</div>
        </Show>
        <Show when={view()} keyed>
          {(preview) => (
            <Show when={frameMode()} keyed>
              {(mode) => <Frame preview={preview} mode={mode.mode} />}
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
