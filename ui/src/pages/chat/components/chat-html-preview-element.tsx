import type {
  CanvasDocumentViewResult,
  SessionsFilesAssetsResult,
} from "@openclaw/gateway-protocol";
import { Errored, Show, createMemo, createSignal, onCleanup, onSettled } from "solid-js";
import type { ApplicationContext } from "../../../app/context.ts";
import { resolveSandboxHostUrl } from "../../../components/sandbox-host.ts";
import { registerBoardEnglish } from "../../../i18n/locales/en-board.ts";
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
import { HtmlPreviewLoading } from "./chat-html-preview-view.tsx";
import type { SessionFileSource } from "./chat-sidebar-content-types.ts";

registerEnglishCatalog(registerFilePreviewEnglish);
registerEnglishCatalog(registerBoardEnglish);

type HtmlPreviewProps = {
  desktop: boolean;
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
    const [retry, setRetry] = createSignal(0);
    let binding: PreviewBinding | undefined;
    let sandboxHost: WidgetSandboxHost | undefined;
    let frameGeneration = 0;

    const isCurrent = (candidate: PreviewBinding | undefined): candidate is PreviewBinding =>
      Boolean(
        candidate &&
        host.isConnected &&
        binding === candidate &&
        context?.gateway.snapshot.phase === "connected" &&
        context.gateway.snapshot.client === candidate.client &&
        candidate.generation === getCanvasWidgetFrameConnectionGeneration() &&
        candidate.html === host.html &&
        candidate.sourceIdentity === host.sourceIdentity &&
        candidate.sessionFileSource?.sessionKey === host.sessionFileSource?.sessionKey &&
        candidate.sessionFileSource?.agentId === host.sessionFileSource?.agentId &&
        candidate.sessionFileSource?.path === host.sessionFileSource?.path &&
        candidate.sessionFileSource?.messageEntryId === host.sessionFileSource?.messageEntryId,
      );

    const sourceInput = createMemo(
      () => {
        const snapshot = gateway?.read().snapshot;
        return [
          props.html,
          props.sourceIdentity,
          props.sessionFileSource?.sessionKey,
          props.sessionFileSource?.agentId,
          props.sessionFileSource?.path,
          props.sessionFileSource?.messageEntryId,
          snapshot?.client,
          snapshot?.phase === "connected",
          getCanvasWidgetFrameConnectionGeneration(),
          retry(),
        ] as const;
      },
      { equals: (previous, next) => previous.every((value, index) => value === next[index]) },
    );

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
          // A failed frame stays terminal until Retry or a mode change.
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
            <HtmlPreviewLoading />
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

    const renderDocument = (input: ReturnType<typeof sourceInput>) => {
      const client = input[6];
      if (!context || !client || !input[7]) {
        binding = undefined;
        return <ErrorNotice message={t("chat.attachments.previewUnavailable")} />;
      }
      const current: PreviewBinding = {
        client,
        html: input[0],
        sourceIdentity: input[1],
        sessionFileSource: host.sessionFileSource && { ...host.sessionFileSource },
        generation: input[8],
      };
      const view = createMemo<PreviewView | undefined>(
        async () => {
          binding = current;
          onCleanup(() => {
            if (binding === current) {
              binding = undefined;
            }
          });
          try {
            // Native bridge bindings settle in the render flush; discard superseded defaults.
            await Promise.resolve();
            if (!isCurrent(current)) {
              return undefined;
            }
            const document = await client.request<CanvasDocumentViewResult>(
              "canvas.document.preview",
              { html: current.html },
              { timeoutMs: WIDGET_LOAD_TIMEOUT_MS },
            );
            if (!isCurrent(current)) {
              return undefined;
            }
            const url = resolveSandboxHostUrl(
              document.sandboxUrl,
              document.sandboxPort,
              document.sandboxOrigin,
              context.gateway.connection.gatewayUrl,
              window.location.origin,
            );
            return { document, binding: current, url, origin: new URL(url).origin };
          } catch (reason) {
            if (isCurrent(current)) {
              throw reason;
            }
            return undefined;
          }
        },
        { loadingValue: undefined },
      );
      return (
        <Errored fallback={(reason) => <ErrorNotice message={formatUiError(reason())} />}>
          <Show when={view()} keyed fallback={<HtmlPreviewLoading />}>
            {(preview) => (
              <Show when={props.embedSandboxMode} keyed>
                {(mode) => renderFrame(preview, mode)}
              </Show>
            )}
          </Show>
        </Errored>
      );
    };

    return (
      <Show when={sourceInput()} keyed>
        {renderDocument}
      </Show>
    );
  },
  {
    properties: {
      desktop: { default: false, type: Boolean },
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

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-html-preview": HTMLAttributes<ChatHtmlPreviewElement> & {
        [Key in keyof HtmlPreviewProps as `prop:${Key}`]?: HtmlPreviewProps[Key];
      };
    }
  }
}
