import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { parseBoardWebsite } from "../../../../../src/boards/board-website.ts";
import { applicationContext, type ApplicationContext } from "../../../app/context.ts";
import { renderBoardWidgetError } from "../../../components/board/board-widget-cell-render.ts";
import { icons } from "../../../components/icons.ts";
import { resolveGatewayHttpOrigin } from "../../../components/sandbox-host.ts";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import type { BoardWidget } from "../types.ts";
import "./website.css";

class OpenClawWebsiteWidget extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @property({ attribute: false }) widget?: BoardWidget;
  @property({ type: Boolean }) active = true;
  private activated = false;

  override willUpdate(): void {
    this.activated ||= this.active;
  }

  override render() {
    if (!this.activated) {
      return nothing;
    }
    let url: URL;
    try {
      url = new URL(parseBoardWebsite(this.widget?.props).url);
    } catch (error) {
      return renderBoardWidgetError(error);
    }
    const gatewayOrigin = resolveGatewayHttpOrigin(
      this.context?.gateway.connection.gatewayUrl ?? "",
      window.location.origin,
    );
    // Cookies are scoped to hosts, so a different port does not isolate Gateway credentials.
    const gatewayHost = new URL(gatewayOrigin).hostname;
    const sameHost = url.hostname === window.location.hostname || url.hostname === gatewayHost;
    return html`<div class="board-website">
      ${
        sameHost
          ? html`<p class="board-website__notice" role="alert">
              ${t("board.widget.websiteSameOrigin")}
            </p>`
          : html`<iframe
              class="board-website__frame"
              title=${this.widget?.title || t("board.widget.kindWebsite")}
              src=${url.href}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
              referrerpolicy="no-referrer"
            ></iframe>`
      }
      <div class="board-website__footer">
        <span class="board-website__origin">${url.host}</span>
        <a
          href=${url.href}
          target="_blank"
          rel="noopener noreferrer"
          title=${t("board.widget.websiteEmbedHint")}
        >
          ${t("board.widget.websiteOpen")}${icons.externalLink}
        </a>
      </div>
    </div>`;
  }
}

if (!customElements.get("openclaw-website-widget")) {
  customElements.define("openclaw-website-widget", OpenClawWebsiteWidget);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-website-widget": OpenClawWebsiteWidget;
  }
}
