import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";
import {
  DEFAULT_BACKGROUND_PREFERENCE,
  type BackgroundPreference,
} from "../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import { subscribeBrowserAuthRestored } from "../app/browser-http.ts";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { resolveProfileAppearancePrefs } from "../app/server-prefs-profile.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import "../styles/session-background.css";
import { backgroundPaletteKey, readBackgroundOpacityLimit } from "./session-background-contrast.ts";
import { backgroundImageReadIdentity, readBackgroundImage } from "./session-background-image.ts";
import { BackgroundFadeLayout } from "./session-background-layout.ts";

export type SessionBackgroundSurface = "new-session" | "session" | "preview";

// Full bleed changes coverage, not readability: retain at least 30% canvas tint.
const FULL_BLEED_MAX_OPACITY = 0.7;

export function backgroundSourceForSurface(
  preference: BackgroundPreference | undefined,
  surface: SessionBackgroundSurface,
): BackgroundPreference["source"] | undefined {
  if (!preference) {
    return undefined;
  }
  const enabled =
    surface === "preview" ||
    (surface === "new-session" ? preference.showOnNewSession : preference.showInSessions);
  return enabled && preference.visibility > 0 ? preference.source : { kind: "none" };
}

/** One decoration per presented pane, outside its transcript/draft scroll container. */
export class SessionBackground extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  @property({ attribute: false })
  context?: ApplicationContext;
  @property({ attribute: false }) surface: SessionBackgroundSurface = "session";
  @property({ attribute: false }) presented = true;
  @property({ attribute: false }) preferenceOverride?: BackgroundPreference;
  private readonly fadeLayout = new BackgroundFadeLayout(this);

  private request: {
    identity: string;
    context: ApplicationContext;
    client: ApplicationContext["gateway"]["snapshot"]["client"];
    controller: AbortController;
    url: string | null;
  } | null = null;
  private source: BackgroundPreference["source"] | undefined;
  private failedIdentity: string | null = null;
  private surfaceElement: HTMLElement | null = null;
  private opacity = 0;
  private paletteKey = "";
  private opacityLimit = 0;
  private readonly accessibility =
    typeof matchMedia === "function"
      ? matchMedia(
          "(forced-colors: active), (prefers-contrast: more), (prefers-reduced-transparency: reduce)",
        )
      : null;
  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.theme,
      (theme, notify) =>
        theme.subscribe(() => {
          this.retireChangedImage();
          notify();
        }),
    )
    .watch(
      () => this.context?.gateway,
      (gateway, notify) =>
        gateway.subscribe(() => {
          // Clear/revoke in the notification, not after a hidden pane's deferred render.
          this.retireChangedImage();
          notify();
        }),
    )
    .effect(
      () => this.ownerDocument.documentElement,
      (root) => {
        // Palette CSS may finish after the preference snapshot notification.
        // Observe only theme presentation attributes, never transcript DOM or frames.
        const observer = new MutationObserver(() => {
          this.requestUpdate();
        });
        observer.observe(root, {
          attributes: true,
          attributeFilter: ["data-theme", "data-theme-mode"],
        });
        return () => observer.disconnect();
      },
    )
    .effect(
      () => this.accessibility,
      (query) => {
        const change = () => {
          this.releaseImage();
          this.requestUpdate();
        };
        query.addEventListener("change", change);
        return () => query.removeEventListener("change", change);
      },
    )
    .effect(
      () => this.context,
      () =>
        subscribeBrowserAuthRestored(() => {
          if (!this.request?.url) {
            this.failedIdentity = null;
            this.releaseImage();
            this.requestUpdate();
          }
        }),
    );

  override connectedCallback() {
    this.setAttribute("aria-hidden", "true");
    this.paletteKey = "";
    super.connectedCallback();
  }

  override disconnectedCallback() {
    this.releaseImage();
    this.fadeLayout.disconnect();
    this.subscriptions.clear();
    this.syncSurface();
    super.disconnectedCallback();
  }

  /** The decoration owns these flags; transcript mutations need no :has() restyle. */
  private syncSurface() {
    const surface =
      this.isConnected && this.surface !== "preview"
        ? this.closest<HTMLElement>(".new-session-page, .sidebar-region")
        : null;
    if (this.surfaceElement !== surface) {
      this.surfaceElement?.removeAttribute("data-background-custom");
      this.surfaceElement?.removeAttribute("data-background-painted");
      this.surfaceElement = surface;
    }
    surface?.toggleAttribute("data-background-custom", this.hasAttribute("data-custom"));
    surface?.toggleAttribute("data-background-painted", this.hasAttribute("data-painted"));
  }

  private currentPreference() {
    return this.surface === "preview"
      ? (this.preferenceOverride ?? this.context?.theme.settings.background)
      : this.context?.theme.settings.background;
  }

  private currentSource() {
    const context = this.context;
    const profileId = context?.gateway.snapshot.selfUser?.id;
    if (
      context &&
      profileId &&
      resolveProfileAppearancePrefs(context.gateway.connection.gatewayUrl, profileId) === null
    ) {
      return undefined;
    }
    return backgroundSourceForSurface(this.currentPreference(), this.surface);
  }

  private currentImageIdentity(): string | null {
    const context = this.context;
    const source = this.currentSource();
    return context && this.presented && !this.accessibility?.matches && source?.kind === "custom"
      ? backgroundImageReadIdentity(context, source.assetId)
      : null;
  }

  private retireChangedImage() {
    if (
      this.request &&
      (this.request.context !== this.context ||
        this.request.client !== this.context?.gateway.snapshot.client ||
        this.request.identity !== this.currentImageIdentity())
    ) {
      this.releaseImage();
    }
  }

  private releaseImage() {
    const request = this.request;
    this.request = null;
    request?.controller.abort();
    if (request?.url) {
      // Preserve Lit's DOM ownership while clearing stale pixels synchronously.
      this.querySelector("img")?.removeAttribute("src");
      this.removeAttribute("data-painted");
      this.syncSurface();
      URL.revokeObjectURL(request.url);
    }
  }

  override willUpdate() {
    const context = this.context;
    const preference = this.currentPreference();
    const fullBleed = preference?.presentation === "full-bleed";
    this.setAttribute("data-presentation", fullBleed ? "full-bleed" : "faded");
    this.setAttribute("data-surface", this.surface);
    this.source = this.currentSource();
    this.toggleAttribute(
      "data-custom",
      this.presented && !this.accessibility?.matches && this.source?.kind === "custom",
    );
    this.syncSurface();
    this.retireChangedImage();
    if (this.presented && !this.accessibility?.matches && this.source?.kind === "custom") {
      const paletteKey = backgroundPaletteKey(this);
      if (paletteKey !== this.paletteKey) {
        this.opacityLimit = readBackgroundOpacityLimit(this);
        this.paletteKey = paletteKey;
      }
    }
    const visibility = preference?.visibility ?? 0;
    // Coverage never relaxes readability. Every photo uses the same palette
    // bound; bundled artwork already passes its theme contrast contract. Light
    // canvases use a gentler photo tint instead of turning into a gray sheet.
    this.opacity =
      this.source?.kind === "theme"
        ? fullBleed
          ? visibility * FULL_BLEED_MAX_OPACITY
          : Math.min(1, visibility / DEFAULT_BACKGROUND_PREFERENCE.visibility)
        : this.opacityLimit * visibility * (context?.theme.resolvedMode === "light" ? 0.65 : 1);
    this.toggleAttribute(
      "data-painted",
      Boolean(
        this.presented &&
        !this.accessibility?.matches &&
        this.opacity > 0 &&
        (this.source?.kind === "theme" || (this.source?.kind === "custom" && this.request?.url)),
      ),
    );
    this.syncSurface();
    const identity = this.currentImageIdentity();
    if (this.failedIdentity !== identity) {
      this.failedIdentity = null;
    }
    if (
      !context ||
      !identity ||
      this.failedIdentity === identity ||
      this.request ||
      this.source?.kind !== "custom"
    ) {
      return;
    }
    const request: NonNullable<SessionBackground["request"]> = {
      identity,
      context,
      client: context.gateway.snapshot.client,
      controller: new AbortController(),
      url: null,
    };
    this.request = request;
    void readBackgroundImage(context, this.source.assetId, {
      signal: request.controller.signal,
      isCurrent: () =>
        this.isConnected && this.request === request && this.currentImageIdentity() === identity,
    })
      .then((url) => {
        if (
          this.request !== request ||
          !this.isConnected ||
          this.currentImageIdentity() !== identity
        ) {
          URL.revokeObjectURL(url);
          return;
        }
        request.url = url;
        this.requestUpdate();
      })
      .catch(() => {
        // Missing/deleted/offline images leave the theme-colored canvas, never an old image.
      });
  }

  override updated() {
    this.fadeLayout.update(
      (this.surface === "new-session" || this.surface === "preview") &&
        this.presented &&
        !this.accessibility?.matches &&
        Boolean(this.source && this.source.kind !== "none") &&
        this.currentPreference()?.presentation !== "full-bleed",
    );
  }

  override render() {
    if (
      !this.source ||
      this.source.kind === "none" ||
      !this.presented ||
      this.accessibility?.matches
    ) {
      return nothing;
    }
    const style = styleMap({ opacity: String(this.opacity) });
    return this.source.kind === "theme"
      ? html`<div
          class="session-background__image session-background__image--theme"
          style=${style}
        ></div>`
      : this.request?.url
        ? html`<img
            class="session-background__image"
            style=${style}
            src=${this.request.url}
            alt=""
            decoding="async"
            draggable="false"
            @error=${() => {
              this.failedIdentity = this.request?.identity ?? null;
              this.releaseImage();
              this.requestUpdate();
            }}
          />`
        : nothing;
  }
}

if (!customElements.get("openclaw-session-background")) {
  customElements.define("openclaw-session-background", SessionBackground);
}
