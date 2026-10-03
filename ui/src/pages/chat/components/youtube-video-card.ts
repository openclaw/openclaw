import { css, html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import type { YouTubeVideo } from "../../../lib/chat/youtube-video.ts";
import { OpenClawLitElement } from "../../../lit/openclaw-element.ts";

const activePlayers = new WeakMap<Document, YouTubeVideoCard>();

class YouTubeVideoCard extends OpenClawLitElement {
  @property({ attribute: false }) video?: YouTubeVideo;
  @property() videoTitle = "";
  @property({ type: Boolean }) enabled = true;
  @state() private playing = false;
  @state() private thumbnailFailed = false;
  @state() private wideEnough = true;
  private sourceIdentity = "";
  private resizeObserver?: ResizeObserver;

  static override styles = css`
    :host {
      display: block;
      min-width: 0;
      margin: 12px 0;
      color: var(--text);
      font: inherit;
    }
    .card {
      overflow: hidden;
      border: 1px solid var(--border);
      border-radius: var(--radius-lg, 12px);
      background: var(--card);
    }
    .stage {
      position: relative;
      width: 100%;
      min-width: 0;
      min-height: 200px;
      aspect-ratio: 16 / 9;
      background: var(--surface);
    }
    .preview,
    iframe {
      position: absolute;
      inset: 0;
      display: block;
      width: 100%;
      height: 100%;
      border: 0;
    }
    .preview {
      padding: 0;
      color: var(--text-strong);
      background: linear-gradient(145deg, var(--elevated), var(--surface));
      cursor: default;
    }
    a.preview {
      cursor: pointer;
    }
    .preview img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .play {
      position: absolute;
      top: 50%;
      left: 50%;
      display: grid;
      width: 64px;
      height: 64px;
      place-items: center;
      transform: translate(-50%, -50%);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-full);
      background: color-mix(in srgb, var(--card) 92%, transparent);
      box-shadow: var(--shadow-md);
    }
    .play svg {
      width: 28px;
      height: 28px;
    }
    .preview:hover .play {
      color: var(--accent);
      border-color: var(--accent);
    }
    .preview:focus-visible,
    .close:focus-visible,
    .watch:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -3px;
    }
    .footer {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 14px;
      flex-wrap: wrap;
    }
    .caption {
      flex: 1;
      min-width: 100px;
    }
    .provider {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.5;
      letter-spacing: 0.04em;
    }
    .title {
      margin: 2px 0 0;
      color: var(--text-strong);
      font-size: 14px;
      font-weight: 600;
      line-height: 1.4;
      overflow-wrap: anywhere;
    }
    .watch {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      color: var(--muted);
      font-size: 12px;
      text-decoration: none;
      cursor: pointer;
    }
    .watch:hover {
      color: var(--accent);
    }
    .watch svg,
    .close svg {
      width: 16px;
      height: 16px;
    }
    .close {
      display: grid;
      width: 30px;
      height: 30px;
      padding: 0;
      place-items: center;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      color: var(--muted);
      background: transparent;
      cursor: default;
    }
    .notice {
      margin: 0;
      padding: 0 14px 12px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.5;
    }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    this.resizeObserver = new ResizeObserver(([entry]) => {
      if (!this.isConnected || !entry) {
        return;
      }
      // YouTube requires a player viewport of at least 200 × 200 CSS pixels.
      this.wideEnough = entry.contentRect.width >= 200;
      if (!this.wideEnough) {
        this.stopPlayback();
      }
    });
    this.resizeObserver.observe(this);
  }

  override disconnectedCallback(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.stopPlayback();
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    const identity = this.video?.watchUrl ?? "";
    if (identity !== this.sourceIdentity) {
      this.sourceIdentity = identity;
      this.stopPlayback();
      this.thumbnailFailed = false;
    }
    if (changed.has("enabled") && !this.enabled) {
      this.stopPlayback();
    }
  }

  private startPlayback(): void {
    activePlayers.get(this.ownerDocument)?.stopPlayback();
    activePlayers.set(this.ownerDocument, this);
    this.playing = true;
  }

  private stopPlayback(): void {
    this.playing = false;
    if (activePlayers.get(this.ownerDocument) === this) {
      activePlayers.delete(this.ownerDocument);
    }
  }

  private previewContents(video: YouTubeVideo, canPlay: boolean) {
    return html`
      ${
        this.thumbnailFailed
          ? nothing
          : html`<img
              src=${video.thumbnailUrl}
              alt=""
              loading="lazy"
              referrerpolicy="no-referrer"
              @error=${() => {
                this.thumbnailFailed = true;
              }}
            />`
      }
      <span class="play" aria-hidden="true">${canPlay ? icons.play : icons.externalLink}</span>
    `;
  }

  override render() {
    const video = this.video;
    if (!video) {
      return nothing;
    }
    const title = this.videoTitle.trim() || t("chat.youtube.video");
    const canPlay = this.enabled && this.wideEnough;
    const playerUrl = new URL(video.embedUrl);
    playerUrl.searchParams.set("autoplay", "1");
    return html`
      <section class="card" aria-label=${title}>
        <div class="stage">
          ${
            this.playing && canPlay
              ? html`<iframe
                  src=${playerUrl.href}
                  title=${t("chat.youtube.player", { title })}
                  sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
                  allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
                  allowfullscreen
                  referrerpolicy="strict-origin-when-cross-origin"
                ></iframe>`
              : canPlay
                ? html`<button
                    class="preview"
                    type="button"
                    aria-label=${t("chat.youtube.play", { title })}
                    @click=${() => this.startPlayback()}
                  >
                    ${this.previewContents(video, true)}
                  </button>`
                : html`<a
                    class="preview"
                    href=${video.watchUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label=${t("chat.youtube.openVideo", { title })}
                    >${this.previewContents(video, false)}</a
                  >`
          }
        </div>
        <div class="footer">
          <div class="caption">
            <span class="provider">${t("chat.youtube.provider")}</span>
            <p class="title">${title}</p>
          </div>
          <a class="watch" href=${video.watchUrl} target="_blank" rel="noopener noreferrer">
            ${t("chat.youtube.open")}${icons.externalLink}
          </a>
          ${
            this.playing
              ? html`<button
                  class="close"
                  type="button"
                  aria-label=${t("chat.youtube.close")}
                  @click=${async () => {
                    this.stopPlayback();
                    await this.updateComplete;
                    this.renderRoot.querySelector<HTMLButtonElement>("button.preview")?.focus();
                  }}
                >
                  ${icons.x}
                </button>`
              : nothing
          }
        </div>
        ${
          !this.enabled || !this.wideEnough
            ? html`<p class="notice" role="status">
                ${t(!this.enabled ? "chat.youtube.strict" : "chat.youtube.narrow")}
              </p>`
            : nothing
        }
      </section>
    `;
  }
}

if (!customElements.get("openclaw-youtube-video")) {
  customElements.define("openclaw-youtube-video", YouTubeVideoCard);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-youtube-video": YouTubeVideoCard;
  }
}
