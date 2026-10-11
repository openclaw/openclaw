import { createEffect, createMemo, createSignal, onCleanup, onSettled, untrack } from "solid-js";
import {
  DEFAULT_BACKGROUND_PREFERENCE,
  type BackgroundPreference,
} from "../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import { subscribeBrowserAuthRestored } from "../app/browser-http.ts";
import type { ApplicationContext } from "../app/context.ts";
import { resolveProfileAppearancePrefs } from "../app/server-prefs-profile.ts";
import { useOptionalApplication } from "../lib/reactive/context.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import "../styles/session-background.css";
import { backgroundPaletteKey, readBackgroundOpacityLimit } from "./session-background-contrast.ts";
import { backgroundImageReadIdentity, readBackgroundImage } from "./session-background-image.ts";
import { BackgroundFadeLayout } from "./session-background-layout.ts";

export type SessionBackgroundSurface = "new-session" | "session" | "preview";
type Props = {
  context?: ApplicationContext;
  surface: SessionBackgroundSurface;
  presented: boolean;
  preferenceOverride?: BackgroundPreference;
};
type BackgroundImageRequest = {
  identity: string;
  context: ApplicationContext;
  client: ApplicationContext["gateway"]["snapshot"]["client"];
  controller: AbortController;
  url: string | null;
};

export type SessionBackground = SolidBridgeElement<Props>;
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
export const SessionBackground = defineSolidBridge<Props>(
  "openclaw-session-background",
  (props, host) => {
    const inheritedContext = useOptionalApplication();
    const context = () => props.context ?? inheritedContext;
    const fadeLayout = new BackgroundFadeLayout(host);
    const [revision, setRevision] = createSignal(0);
    const notify = () => setRevision((value) => value + 1);
    const [image, setImage] = createSignal<string>();
    const accessibility =
      typeof matchMedia === "function"
        ? matchMedia(
            "(forced-colors: active), (prefers-contrast: more), (prefers-reduced-transparency: reduce)",
          )
        : null;
    let request: BackgroundImageRequest | null = null;
    let failedIdentity: string | null = null;
    let surfaceElement: HTMLElement | null = null;
    let paletteKey = "";
    let opacityLimit = 0;
    const preference = () =>
      props.surface === "preview"
        ? (props.preferenceOverride ?? context()?.theme.settings.background)
        : context()?.theme.settings.background;
    const currentSource = () => {
      const app = context();
      const profileId = app?.gateway.snapshot.selfUser?.id;
      if (
        app &&
        profileId &&
        resolveProfileAppearancePrefs(app.gateway.connection.gatewayUrl, profileId) === null
      ) {
        return undefined;
      }
      return backgroundSourceForSurface(preference(), props.surface);
    };
    const currentIdentity = () => {
      const source = currentSource();
      return context() && props.presented && !accessibility?.matches && source?.kind === "custom"
        ? backgroundImageReadIdentity(context()!, source.assetId)
        : null;
    };
    const syncSurface = () =>
      untrack(() => {
        const surface =
          host.isConnected && props.surface !== "preview"
            ? host.closest<HTMLElement>(".new-session-page, .sidebar-region")
            : null;
        if (surfaceElement !== surface) {
          surfaceElement?.removeAttribute("data-background-custom");
          surfaceElement?.removeAttribute("data-background-painted");
          surfaceElement = surface;
        }
        surface?.toggleAttribute("data-background-custom", host.hasAttribute("data-custom"));
        surface?.toggleAttribute("data-background-painted", host.hasAttribute("data-painted"));
      });
    const releaseImage = () => {
      const prior = request;
      request = null;
      prior?.controller.abort();
      setImage(undefined);
      if (prior?.url) {
        // Clear private pixels in the owner notification, before deferred DOM work.
        host.querySelector("img")?.removeAttribute("src");
        host.removeAttribute("data-painted");
        syncSurface();
        URL.revokeObjectURL(prior.url);
      }
    };
    const retireChangedImage = () =>
      untrack(() => {
        if (
          request &&
          (request.context !== context() ||
            request.client !== context()?.gateway.snapshot.client ||
            request.identity !== currentIdentity())
        ) {
          releaseImage();
        }
      });
    createEffect(
      () => context(),
      (application) => {
        const changed = () => {
          retireChangedImage();
          notify();
        };
        const cleanups = [
          application?.theme.subscribe(changed),
          application?.gateway.subscribe(changed),
          subscribeBrowserAuthRestored(() => {
            if (!request?.url) {
              failedIdentity = null;
              releaseImage();
              notify();
            }
          }),
        ];
        return () => cleanups.forEach((cleanup) => cleanup?.());
      },
    );
    const observer = new MutationObserver(notify);
    observer.observe(host.ownerDocument.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-theme-mode"],
    });
    const accessibilityChanged = () => {
      releaseImage();
      notify();
    };
    accessibility?.addEventListener("change", accessibilityChanged);
    onCleanup(() => {
      observer.disconnect();
      accessibility?.removeEventListener("change", accessibilityChanged);
      releaseImage();
      fadeLayout.disconnect();
      surfaceElement?.removeAttribute("data-background-custom");
      surfaceElement?.removeAttribute("data-background-painted");
    });
    onSettled(() => {
      // The bridge's inner root settles before its host joins the outer Solid tree.
      queueMicrotask(() => {
        if (host.isConnected) {
          notify();
        }
      });
    });
    const view = createMemo(() => {
      revision();
      const source = currentSource();
      const fullBleed = preference()?.presentation === "full-bleed";
      const visible = props.presented && !accessibility?.matches;
      // Direct Solid mounts compute before the bridge host inherits its palette.
      if (visible && source?.kind === "custom" && host.isConnected) {
        const key = backgroundPaletteKey(host);
        if (paletteKey !== key) {
          opacityLimit = readBackgroundOpacityLimit(host);
          paletteKey = key;
        }
      }
      const visibility = preference()?.visibility ?? 0;
      const opacity =
        source?.kind === "theme"
          ? fullBleed
            ? visibility * FULL_BLEED_MAX_OPACITY
            : Math.min(1, visibility / DEFAULT_BACKGROUND_PREFERENCE.visibility)
          : opacityLimit * visibility * (context()?.theme.resolvedMode === "light" ? 0.65 : 1);
      return {
        source,
        fullBleed,
        visible,
        opacity,
        surface: props.surface,
        context: context(),
        identity: currentIdentity(),
      };
    });
    createEffect(
      () => ({ ...view(), image: image() }),
      (state) => {
        host.setAttribute("aria-hidden", "true");
        host.setAttribute("data-presentation", state.fullBleed ? "full-bleed" : "faded");
        host.setAttribute("data-surface", state.surface);
        host.toggleAttribute("data-custom", state.visible && state.source?.kind === "custom");
        retireChangedImage();
        host.toggleAttribute(
          "data-painted",
          Boolean(
            state.visible &&
            state.opacity > 0 &&
            (state.source?.kind === "theme" || (state.source?.kind === "custom" && state.image)),
          ),
        );
        syncSurface();
        fadeLayout.update(
          (state.surface === "new-session" || state.surface === "preview") &&
            state.visible &&
            Boolean(state.source && state.source.kind !== "none") &&
            !state.fullBleed,
        );
        if (failedIdentity !== state.identity) {
          failedIdentity = null;
        }
        if (
          !host.isConnected ||
          !state.context ||
          !state.identity ||
          failedIdentity === state.identity ||
          request ||
          state.source?.kind !== "custom"
        ) {
          return;
        }
        const pending: BackgroundImageRequest = {
          identity: state.identity,
          context: state.context,
          client: state.context.gateway.snapshot.client,
          controller: new AbortController(),
          url: null,
        };
        request = pending;
        void readBackgroundImage(state.context, state.source.assetId, {
          signal: pending.controller.signal,
          isCurrent: () =>
            untrack(
              () =>
                host.isConnected && request === pending && currentIdentity() === pending.identity,
            ),
        })
          .then((url) => {
            if (
              request !== pending ||
              !host.isConnected ||
              currentIdentity() !== pending.identity
            ) {
              URL.revokeObjectURL(url);
              return;
            }
            pending.url = url;
            setImage(url);
          })
          .catch(() => {
            /* Missing/deleted/offline images leave the theme-colored canvas. */
          });
      },
    );
    return (
      <>
        {view().visible && view().source && view().source?.kind !== "none" ? (
          view().source?.kind === "theme" ? (
            <div
              class="session-background__image session-background__image--theme"
              style={{ opacity: String(view().opacity) }}
            />
          ) : image() ? (
            <img
              class="session-background__image"
              style={{ opacity: String(view().opacity) }}
              src={image()}
              alt=""
              decoding="async"
              draggable="false"
              onError={() => {
                failedIdentity = request?.identity ?? null;
                releaseImage();
                notify();
              }}
            />
          ) : undefined
        ) : undefined}
      </>
    );
  },
  {
    properties: {
      context: { default: undefined, attribute: false },
      surface: { default: "session", attribute: false },
      presented: { default: true, attribute: false },
      preferenceOverride: { default: undefined, attribute: false },
    },
  },
);
