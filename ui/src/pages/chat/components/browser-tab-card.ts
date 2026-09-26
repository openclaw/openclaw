import { consume } from "@lit/context";
import { css, html, nothing, unsafeCSS } from "lit";
import { property, state } from "lit/decorators.js";
import type { ControlUiLinkPreview } from "../../../../../src/gateway/control-ui-contract.js";
import { applicationContext, type ApplicationContext } from "../../../app/context.ts";
import { resolveControlUiAuthToken } from "../../../app/control-ui-auth.ts";
import { isBrowserPanelAvailable } from "../../../app/panel-availability.ts";
import { browserTabKey, readBrowserTabTarget } from "../../../components/browser/browser-target.ts";
import { icons } from "../../../components/icons.ts";
import "../../../components/web-awesome.ts";
import { BROWSER_PANEL_TOGGLE_EVENT } from "../../../components/panel-toggle-contract.ts";
import { t } from "../../../i18n/index.ts";
import { loadBrowserTabThumbnail } from "../../../lib/chat/browser-tab-preview.ts";
import type { ToolPreview } from "../../../lib/chat/tool-cards.ts";
import { copyToClipboard } from "../../../lib/clipboard.ts";
import { canCallGatewayMethod } from "../../../lib/gateway-methods.ts";
import { loadLinkPreview } from "../../../lib/link-preview.ts";
import { openExternalUrlSafe } from "../../../lib/open-external-url.ts";
import { OpenClawLitElement } from "../../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../../lit/subscriptions-controller.ts";
import sessionMenuStyles from "../../../styles/session-menu.css?inline";

class OpenClawBrowserTabCard extends OpenClawLitElement {
  @consume({ context: applicationContext, subscribe: true })
  @property({ attribute: false })
  context?: ApplicationContext;
  @property({ attribute: false }) preview?: Extract<ToolPreview, { kind: "browser-tab" }>;
  @property({ attribute: false }) revision?: string;
  @property({ type: Boolean }) latest = false;

  @state() private thumbnailSrc?: string;
  @state() private pagePreview?: ControlUiLinkPreview;
  private requestIdentity?: { client: unknown; key: string };
  private pageIdentity?: {
    client: unknown;
    url: string;
    generation: number;
    recoveryScope: string;
  };
  private readonly failedImages = new Set<string>();

  private readonly subscriptions = new SubscriptionsController(this);
  constructor() {
    super();
    this.subscriptions.watch(
      () => this.context?.gateway,
      (gateway, notify) => gateway.subscribe(notify),
    );
    this.subscriptions.watch(
      () => this.context?.config,
      (config, notify) => config.subscribe(notify),
    );
  }

  static override styles = [
    unsafeCSS(sessionMenuStyles),
    css`
      :host {
        display: block;
        max-width: 320px;
        margin-block: 6px;
      }
      .card {
        overflow: hidden;
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      .shot {
        display: block;
        width: 100%;
        padding: 0;
        background: none;
        border: 0;
        cursor: default;
      }
      .shot img {
        display: block;
        width: 100%;
        height: auto;
        max-height: 240px;
        object-fit: cover;
        object-position: top;
      }
      .shot.social img {
        aspect-ratio: 1.91;
        object-fit: contain;
        object-position: center;
      }
      .bar {
        position: relative;
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        padding: 7px 8px 7px 10px;
      }
      .shot + .bar {
        border-top: 1px solid var(--border);
      }
      .icon {
        display: flex;
        flex: 0 0 20px;
        align-items: center;
        justify-content: center;
        color: var(--muted);
      }
      .icon svg,
      .icon img {
        width: 16px;
        height: 16px;
      }
      .icon img {
        box-sizing: border-box;
        width: 20px;
        height: 20px;
        padding: 2px;
        object-fit: contain;
        /* Site icons are often dark on transparent; retain their colors on a light plate. */
        background: var(--button-icon-bg);
        border-radius: 4px;
      }
      .identity {
        display: grid;
        flex: 1;
        min-width: 0;
        gap: 1px;
      }
      .title,
      .url {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .title {
        font-size: 0.8rem;
        font-weight: 500;
      }
      .url {
        color: var(--muted);
        font-size: 0.72rem;
      }
      .actions {
        display: flex;
        flex: none;
        gap: 2px;
        align-items: center;
        opacity: 0;
        transition: opacity 120ms ease;
      }
      .card:hover .actions,
      .card:focus-within .actions,
      .actions:has(wa-dropdown[open]) {
        opacity: 1;
      }
      .actions button {
        display: flex;
        align-items: center;
        padding: 4px 8px;
        color: var(--text);
        font: inherit;
        font-size: 0.75rem;
        background: none;
        border: 0;
        border-radius: var(--radius-sm);
        cursor: default;
      }
      .actions button:hover {
        background: var(--panel-hover);
      }
      .actions button:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: -2px;
      }
      .actions .more svg {
        width: 16px;
        height: 16px;
      }
    `,
  ];

  private get canLoadPagePreview() {
    return Boolean(
      this.context?.config.current.automaticallyFetchFavicons &&
      canCallGatewayMethod(
        this.context.gateway.snapshot,
        "controlUi.linkPreview",
        "operator.read",
        {
          requireAdvertisement: false,
        },
      ),
    );
  }

  private updatePagePreview() {
    const client = this.context?.gateway.snapshot.client;
    const url = this.preview?.url;
    if (!this.canLoadPagePreview || !client || !url) {
      this.pageIdentity = undefined;
      this.pagePreview = undefined;
      return;
    }
    if (this.pagePreviewCurrent) {
      return;
    }
    const identity = {
      client,
      url,
      generation: client.connectionGeneration,
      recoveryScope: client.recoveryScope,
    };
    this.pageIdentity = identity;
    this.pagePreview = undefined;
    this.failedImages.clear();
    void loadLinkPreview(client, url).then((preview) => {
      // Recycled transcript cards and connection/config changes retire the old
      // request; its result must never become another page's preview.
      if (this.isConnected && this.pageIdentity === identity && this.pagePreviewCurrent) {
        this.pagePreview = preview;
      }
    });
  }

  private get pagePreviewCurrent(): boolean {
    const identity = this.pageIdentity;
    const client = this.context?.gateway.snapshot.client;
    return Boolean(
      identity &&
      client &&
      this.canLoadPagePreview &&
      identity.client === client &&
      identity.url === this.preview?.url &&
      identity.generation === client.connectionGeneration &&
      identity.recoveryScope === client.recoveryScope,
    );
  }

  override disconnectedCallback() {
    this.pageIdentity = undefined;
    this.pagePreview = undefined;
    super.disconnectedCallback();
  }

  override updated() {
    this.updatePagePreview();
    const preview = this.preview;
    const context = this.context;
    const snapshot = context?.gateway.snapshot;
    const client = snapshot?.client;
    const revision = this.revision;
    if (
      !preview ||
      !context ||
      !snapshot ||
      !client ||
      !isBrowserPanelAvailable(snapshot) ||
      !this.latest ||
      !revision
    ) {
      if (!this.latest || !snapshot || !isBrowserPanelAvailable(snapshot)) {
        // Dropping the request marker keeps a pending capture from landing and
        // lets a later availability recovery re-request the thumbnail.
        this.requestIdentity = undefined;
        this.thumbnailSrc = undefined;
      }
      return;
    }
    const key = JSON.stringify([browserTabKey(preview), revision]);
    if (this.requestIdentity?.key === key && this.requestIdentity.client === client) {
      return;
    }
    const identity = { client, key };
    this.requestIdentity = identity;
    this.thumbnailSrc = undefined;
    void loadBrowserTabThumbnail({
      client,
      tab: preview,
      revision,
      resourceBasePath: context.resourceBasePath,
      authToken: resolveControlUiAuthToken({
        hello: snapshot.hello,
        settings: { token: context.gateway.connection.token },
        password: context.gateway.connection.password,
      }),
    }).then((src) => {
      if (this.requestIdentity === identity) {
        this.thumbnailSrc = src;
      }
    });
  }

  private readonly openPanel = () => {
    const browserTab = readBrowserTabTarget(this.preview);
    if (!browserTab) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent(BROWSER_PANEL_TOGGLE_EVENT, {
        detail: { open: true, browserTab },
        bubbles: true,
        composed: true,
      }),
    );
  };

  private readonly onMenuSelect = (event: CustomEvent<{ item: { value?: string } }>) => {
    const url = this.preview?.url;
    if (!url) {
      return;
    }
    if (event.detail.item.value === "copy-url") {
      void copyToClipboard(url, () => this.isConnected && this.preview?.url === url);
    } else if (event.detail.item.value === "open-new-tab") {
      openExternalUrlSafe(url);
    }
  };

  override render() {
    const preview = this.preview;
    if (!preview) {
      return nothing;
    }
    const currentImage =
      this.requestIdentity?.client === this.context?.gateway.snapshot.client &&
      this.requestIdentity?.key === JSON.stringify([browserTabKey(preview), this.revision])
        ? this.thumbnailSrc
        : undefined;
    const page = this.pagePreviewCurrent ? this.pagePreview : undefined;
    const favicon = page?.faviconDataUrl;
    const image =
      currentImage && !this.failedImages.has(currentImage) ? currentImage : page?.imageDataUrl;
    let host = preview.url;
    try {
      host = new URL(preview.url ?? "").host || preview.url;
    } catch {
      // Internal page URLs can have no host; keep the supplied label.
    }
    const title = preview.title?.trim() || page?.title || host || t("browser.title");
    const label = preview.url ? `${title} — ${preview.url}` : title;
    return html`
      <div class="card">
        ${
          image && !this.failedImages.has(image)
            ? html`
                <button
                  type="button"
                  class=${image === currentImage ? "shot" : "shot social"}
                  aria-label=${label}
                  title=${t("browser.openPanel")}
                  @click=${this.openPanel}
                >
                  <img
                    src=${image}
                    alt=""
                    @error=${() => {
                      this.failedImages.add(image);
                      this.requestUpdate();
                    }}
                  />
                </button>
              `
            : nothing
        }
        <div class="bar">
          <span class="icon" aria-hidden="true"
            >${
              favicon && !this.failedImages.has(favicon)
                ? html`<img
                    src=${favicon}
                    alt=""
                    @error=${() => {
                      this.failedImages.add(favicon);
                      this.requestUpdate();
                    }}
                  />`
                : icons.globe
            }</span
          >
          <span class="identity">
            <span class="title">${title}</span>
            ${preview.url ? html`<span class="url">${preview.url}</span>` : nothing}
          </span>
          <span class="actions">
            <button type="button" title=${t("browser.openPanel")} @click=${this.openPanel}>
              ${t("browser.open")}
            </button>
            <wa-dropdown
              class="session-menu"
              placement="bottom-end"
              @wa-select=${this.onMenuSelect}
            >
              <button
                slot="trigger"
                type="button"
                class="more"
                aria-label=${t("browser.moreActions")}
                aria-haspopup="menu"
                title=${t("browser.moreActions")}
              >
                ${icons.moreHorizontal}
              </button>
              <wa-dropdown-item class="session-menu__item" value="copy-url">
                <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.copy}</span>
                ${t("browser.copyUrl")}
              </wa-dropdown-item>
              <wa-dropdown-item class="session-menu__item" value="open-new-tab" data-new-tab-action>
                <span slot="icon" class="session-menu__icon" aria-hidden="true"
                  >${icons.externalLink}</span
                >
                ${t("browser.openNewTab")}
              </wa-dropdown-item>
            </wa-dropdown>
          </span>
        </div>
      </div>
    `;
  }
}

if (!customElements.get("openclaw-browser-tab-card")) {
  customElements.define("openclaw-browser-tab-card", OpenClawBrowserTabCard);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-browser-tab-card": OpenClawBrowserTabCard;
  }
}
