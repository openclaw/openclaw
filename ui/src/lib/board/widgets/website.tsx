import { createMemo, createSignal, Show } from "solid-js";
import { parseBoardWebsite } from "../../../../../src/boards/board-website.ts";
import { BoardWidgetError } from "../../../components/board/board-widget-error.tsx";
import { resolveGatewayHttpOrigin } from "../../../components/sandbox-host.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerBoardDocumentEnglish } from "../../../i18n/locales/en-board-document.ts";
import { registerBoardWebsiteEnglish } from "../../../i18n/locales/en-board-website.ts";
import { useOptionalApplication } from "../../reactive/context.ts";
import { registerEnglishCatalog, t } from "../../reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../solid-bridge.ts";
import type { BoardWidget } from "../types.ts";
import "./website.css";

registerEnglishCatalog(registerBoardDocumentEnglish);

registerBoardWebsiteEnglish();
type WebsiteWidgetProps = { widget?: BoardWidget; active: boolean };
function WebsiteWidgetContent(props: WebsiteWidgetProps) {
  const context = useOptionalApplication();
  const [activated] = createSignal((previous = false) => previous || props.active);
  const content = createMemo(() => {
    try {
      const url = new URL(parseBoardWebsite(props.widget?.props).url);
      const gatewayOrigin = resolveGatewayHttpOrigin(
        context?.gateway.connection.gatewayUrl ?? "",
        window.location.origin,
      );
      // Cookies are scoped to hosts, so a different port does not isolate Gateway credentials.
      const sameHost =
        url.hostname === window.location.hostname ||
        url.hostname === new URL(gatewayOrigin).hostname;
      return { url, sameHost };
    } catch (error) {
      return { error };
    }
  });
  return (
    <Show when={activated()}>
      <Show when={content().url} fallback={<BoardWidgetError error={content().error} />}>
        <div class="board-website">
          <Show
            when={!content().sameHost}
            fallback={
              <p class="board-website__notice" role="alert">
                {t("board.widget.websiteSameOrigin")}
              </p>
            }
          >
            <iframe
              class="board-website__frame"
              title={props.widget?.title || t("board.widget.kindWebsite")}
              src={content().url?.href}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
              referrerpolicy="no-referrer"
            />
          </Show>
          <div class="board-website__footer">
            <span class="board-website__origin">{content().url?.host}</span>
            <a
              href={content().url?.href}
              target="_blank"
              rel="noopener noreferrer"
              title={t("board.widget.websiteEmbedHint")}
            >
              {t("board.widget.websiteOpen")}
              <Icon name="externalLink" />
            </a>
          </div>
        </div>
      </Show>
    </Show>
  );
}
export const WebsiteWidget = defineSolidBridge<WebsiteWidgetProps>(
  "openclaw-website-widget",
  WebsiteWidgetContent,
  {
    properties: {
      widget: { default: undefined, attribute: false },
      active: { default: true, type: Boolean },
    },
  },
);
declare global {
  interface HTMLElementTagNameMap {
    "openclaw-website-widget": SolidBridgeElement<WebsiteWidgetProps>;
  }
}
