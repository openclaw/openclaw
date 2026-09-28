import { html, type PropertyValues } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { styleMap } from "lit/directives/style-map.js";
import {
  MAX_LOBSTER_ARTWORK_BYTES,
  type LobsterPose,
} from "../../../packages/gateway-protocol/src/lobsterdex.ts";
import { matchControlUiResourceUrl } from "../../../src/gateway/control-ui-resource-routes.js";
import type { ControlUiClawmoji } from "../../../src/plugin-sdk/control-ui-lobsterdex.ts";
import { t } from "../i18n/index.ts";
import {
  fetchGatewayContextResource,
  readAvatarGatewayContext,
  registerAvatarGatewayReset,
} from "../lib/identity-avatar-context.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { canonicalLobsterLook, lobsterLookStyle, renderLobsterSvg } from "./lobster-pet-look.ts";
import { LOBSTER_PET_PALETTES } from "./lobster-pet-palettes.ts";
import "../styles/clawmoji.css";

export type ClawmojiProps = {
  entry: ControlUiClawmoji | null;
  pose?: LobsterPose;
  size?: number;
  label: string;
};

/** Shared light-DOM renderer: built-ins retain the host's palette and geometry styles. */
export class ClawmojiElement extends OpenClawLightDomElement {
  static override properties = {
    entry: { attribute: false },
    pose: { type: String },
    size: { type: Number },
    label: { type: String },
  };

  declare entry: ControlUiClawmoji | null;
  declare pose: LobsterPose;
  declare size: number;
  declare label: string;
  private artworkUrl: string | null = null;
  private artworkGeneration = 0;
  private artworkDirty = true;
  private stopGatewayReset?: () => void;
  private frame = 0;
  private imageWidth = 0;
  private imageHeight = 0;
  private failed = false;
  private animationFrame: number | undefined;
  private animationStart: number | undefined;
  private motion: MediaQueryList | undefined;

  constructor() {
    super();
    this.entry = null;
    this.pose = "idle";
    this.size = 64;
    this.label = "";
  }

  override connectedCallback() {
    super.connectedCallback();
    this.artworkDirty = true;
    this.stopGatewayReset = registerAvatarGatewayReset(() => {
      this.releaseArtwork();
      this.artworkDirty = true;
      // The context owner installs replacement credentials after notifying resets.
      this.requestUpdate();
    });
    this.motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.motion.addEventListener("change", this.restartAnimation);
    this.restartAnimation();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.stopAnimation();
    this.stopGatewayReset?.();
    this.stopGatewayReset = undefined;
    this.releaseArtwork();
    this.motion?.removeEventListener("change", this.restartAnimation);
  }

  protected override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("entry") || this.artworkDirty) {
      this.artworkDirty = false;
      this.releaseArtwork();
      this.imageWidth = 0;
      this.imageHeight = 0;
      this.failed = false;
      void this.loadArtwork();
    }
    if (changed.has("entry") || changed.has("pose")) {
      this.restartAnimation();
    }
  }

  private releaseArtwork() {
    this.artworkGeneration++;
    this.stopAnimation();
    if (this.artworkUrl) {
      URL.revokeObjectURL(this.artworkUrl);
    }
    this.artworkUrl = null;
    this.imageWidth = 0;
    this.imageHeight = 0;
  }

  private async loadArtwork() {
    const appearance = this.entry?.appearance;
    if (!this.isConnected || !appearance || appearance.kind === "builtin") {
      return;
    }
    const generation = this.artworkGeneration;
    const current = () => this.isConnected && generation === this.artworkGeneration;
    try {
      if (!matchControlUiResourceUrl("pluginLobsterArt", appearance.url)) {
        throw new Error("Unsupported Lobster Pack artwork route");
      }
      const context = readAvatarGatewayContext();
      const url = new URL(
        `${context.resourceBasePath}${appearance.url}`,
        context.origin ?? window.location.origin,
      ).href;
      const response = await fetchGatewayContextResource(url, 15_000);
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Lobster Pack artwork unavailable");
      }
      const blob = await response.blob();
      const expectedType = appearance.kind === "svg" ? "image/svg+xml" : "image/png";
      if (
        blob.type.split(";", 1)[0]?.trim().toLowerCase() !== expectedType ||
        blob.size === 0 ||
        blob.size > MAX_LOBSTER_ARTWORK_BYTES
      ) {
        throw new Error("Invalid Lobster Pack artwork response");
      }
      if (!current()) {
        return;
      }
      this.artworkUrl = URL.createObjectURL(blob);
    } catch {
      if (!current()) {
        return;
      }
      this.failed = true;
    }
    this.requestUpdate();
  }

  private stopAnimation() {
    if (this.animationFrame !== undefined) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = undefined;
    }
  }

  private restartAnimation = () => {
    this.stopAnimation();
    this.animationStart = undefined;
    const appearance = this.entry?.appearance;
    this.frame =
      appearance?.kind === "sprite-atlas"
        ? this.motion?.matches
          ? appearance.reducedMotionFrame
          : ((appearance.animations[this.pose] ?? appearance.animations.idle)?.frames[0] ?? 0)
        : 0;
    this.requestUpdate();
    if (
      this.isConnected &&
      !this.motion?.matches &&
      !this.failed &&
      this.imageWidth > 0 &&
      appearance?.kind === "sprite-atlas"
    ) {
      this.animationFrame = requestAnimationFrame(this.advanceFrame);
    }
  };

  private advanceFrame = (now: number) => {
    this.animationFrame = undefined;
    const appearance = this.entry?.appearance;
    if (
      appearance?.kind !== "sprite-atlas" ||
      !this.isConnected ||
      this.motion?.matches ||
      this.failed
    ) {
      return;
    }
    const animation = appearance.animations[this.pose] ?? appearance.animations.idle;
    if (!animation || animation.frames.length === 0) {
      return;
    }
    this.animationStart ??= now;
    const elapsedFrames = Math.floor(((now - this.animationStart) * animation.fps) / 1000);
    const index = animation.loop
      ? elapsedFrames % animation.frames.length
      : Math.min(elapsedFrames, animation.frames.length - 1);
    const frame = animation.frames[index] ?? 0;
    if (this.frame !== frame) {
      this.frame = frame;
      this.requestUpdate();
    }
    if (
      animation.frames.length > 1 &&
      (animation.loop || elapsedFrames < animation.frames.length - 1)
    ) {
      this.animationFrame = requestAnimationFrame(this.advanceFrame);
    }
  };

  private imageLoaded = (event: Event) => {
    const image = event.currentTarget;
    const appearance = this.entry?.appearance;
    if (
      !(image instanceof HTMLImageElement) ||
      !this.contains(image) ||
      !appearance ||
      appearance.kind === "builtin" ||
      image.getAttribute("src") !== this.artworkUrl
    ) {
      return;
    }
    this.imageWidth = image.naturalWidth;
    this.imageHeight = image.naturalHeight;
    if (appearance.kind === "sprite-atlas") {
      const count =
        (this.imageWidth / appearance.frameWidth) * (this.imageHeight / appearance.frameHeight);
      this.failed =
        this.imageWidth % appearance.frameWidth !== 0 ||
        this.imageHeight % appearance.frameHeight !== 0 ||
        count < 1 ||
        appearance.reducedMotionFrame >= count ||
        Object.values(appearance.animations).some((animation) =>
          animation?.frames.some((frame) => frame >= count),
        );
    }
    this.restartAnimation();
  };

  private imageFailed = (event: Event) => {
    const image = event.currentTarget;
    if (!(image instanceof HTMLImageElement) || !this.contains(image)) {
      return;
    }
    this.failed = true;
    this.stopAnimation();
    this.requestUpdate();
  };

  protected override render() {
    const size = Number.isFinite(this.size) ? Math.max(16, Math.min(512, this.size)) : 64;
    const appearance = this.entry?.appearance;
    const palette =
      appearance?.kind === "builtin"
        ? LOBSTER_PET_PALETTES.find((candidate) => candidate.id === appearance.paletteId)
        : undefined;
    const unavailable = !appearance || this.failed || (appearance.kind === "builtin" && !palette);
    const look = palette ? canonicalLobsterLook(palette) : null;
    const atlas = appearance?.kind === "sprite-atlas" ? appearance : null;
    const scale = atlas ? size / Math.max(atlas.frameWidth, atlas.frameHeight) : 1;
    const columns = atlas && this.imageWidth ? this.imageWidth / atlas.frameWidth : 1;
    return html`<span
      class="clawmoji"
      role="img"
      aria-label=${unavailable ? t("quickSettings.appearance.lobsterdexArtworkUnavailable", { name: this.label }) : this.label}
      data-state=${unavailable ? "unavailable" : "ready"}
      style=${styleMap({ width: `${size}px`, height: `${size}px` })}
    >
      ${
        unavailable
          ? html`<span class="clawmoji__unavailable" aria-hidden="true">?</span>`
          : look
            ? html` <span
                class="clawmoji__builtin lobster-pet lobster-pet--palette-${palette?.id}"
                style=${lobsterLookStyle(look)}
              >
                ${renderLobsterSvg(look, { standalone: true, sleeping: this.pose === "sleeping", grumpy: this.pose === "error", reading: this.pose === "busy" })}
              </span>`
            : appearance && appearance.kind !== "builtin" && this.artworkUrl
              ? keyed(
                  this.artworkUrl,
                  html` <span
                    class="clawmoji__art ${atlas ? "" : `clawmoji__art--${this.pose}`}"
                    style=${styleMap({ width: atlas ? `${atlas.frameWidth * scale}px` : "100%", height: atlas ? `${atlas.frameHeight * scale}px` : "100%", transformOrigin: `${appearance.anchor.x * 100}% ${appearance.anchor.y * 100}%` })}
                  >
                    <img
                      class="clawmoji__image"
                      src=${this.artworkUrl}
                      alt=""
                      draggable="false"
                      @load=${this.imageLoaded}
                      @error=${this.imageFailed}
                      style=${styleMap(atlas ? { width: this.imageWidth ? `${this.imageWidth * scale}px` : "auto", height: this.imageHeight ? `${this.imageHeight * scale}px` : "auto", maxWidth: "none", visibility: this.imageWidth ? "visible" : "hidden", transform: `translate(${-((this.frame % columns) * atlas.frameWidth * scale)}px, ${-(Math.floor(this.frame / columns) * atlas.frameHeight * scale)}px)` } : {})}
                    />
                  </span>`,
                )
              : ""
      }
    </span>`;
  }
}

if (!customElements.get("openclaw-clawmoji")) {
  customElements.define("openclaw-clawmoji", ClawmojiElement);
}

export function renderClawmoji(props: ClawmojiProps) {
  return html`<openclaw-clawmoji
    .entry=${props.entry}
    .pose=${props.pose ?? "idle"}
    .size=${props.size ?? 64}
    .label=${props.label}
  ></openclaw-clawmoji>`;
}
