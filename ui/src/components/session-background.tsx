import { createEffect, createMemo, createSignal, onSettled } from "solid-js";
import {
  DEFAULT_BACKGROUND_PREFERENCE,
  type BackgroundPreference,
} from "../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import { subscribeBrowserAuthRestored } from "../app/browser-http.ts";
import type { ApplicationContext } from "../app/context.ts";
import { resolveProfileAppearancePrefs } from "../app/server-prefs-profile.ts";
import { useOptionalApplication } from "../lib/reactive/context.ts";
import { observeDocumentRootAttributes } from "../lib/reactive/document-root-attributes.ts";
import { listen } from "../lib/reactive/listener.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import "../styles/session-background.css";
import { backgroundPaletteKey, readBackgroundOpacityLimit } from "./session-background-contrast.ts";
import type {
  SessionBackground,
  SessionBackgroundProps,
  SessionBackgroundSurface,
} from "./session-background-host.tsx";
import { backgroundImageReadIdentity, readBackgroundImage } from "./session-background-image.ts";
import type { SessionBackgroundLayoutTarget } from "./session-background-layout-context.tsx";

/** Observe layout changes, never scrolling or animation frames. */
function createBackgroundFadeLayout(host: HTMLElement) {
  let observer: ResizeObserver | null = null;
  let targets: Element[] = [];
  let layoutTargets: readonly SessionBackgroundLayoutTarget[] = [];
  onSettled(() => {
    observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    targets.forEach((node) => observer?.observe(node));
    return disconnect;
  });

  function findTarget(kind: SessionBackgroundLayoutTarget["kind"]) {
    let first: HTMLElement | undefined;
    for (const target of layoutTargets) {
      if (target.kind !== kind || !host.parentElement?.contains(target.element)) {
        continue;
      }
      if (
        !first ||
        first.compareDocumentPosition(target.element) & Node.DOCUMENT_POSITION_PRECEDING
      ) {
        first = target.element;
      }
    }
    return first;
  }

  function update(enabled: boolean, registered: readonly SessionBackgroundLayoutTarget[] = []) {
    layoutTargets = registered;
    if (!enabled) {
      disconnect();
      return;
    }
    const parent = host.parentElement;
    const composer = findTarget("composer");
    const welcome = findTarget("welcome");
    const next = [parent, composer, welcome].filter((node): node is HTMLElement => Boolean(node));
    if (next.length !== targets.length || next.some((node, index) => node !== targets[index])) {
      disconnect();
      targets = next;
      targets.forEach((node) => observer?.observe(node));
    }
    measure();
  }

  function measure() {
    const composer = findTarget("composer");
    const origin = host.getBoundingClientRect();
    const box = composer?.getBoundingClientRect();
    const scroll = findTarget("scroll")?.scrollTop ?? 0;
    const end = box
      ? Math.max(0, box.top - origin.top + scroll + box.height / 2)
      : origin.height * 0.55;
    const value = Math.round(end) + "px";
    if (host.style.getPropertyValue("--session-background-fade-end") !== value) {
      host.style.setProperty("--session-background-fade-end", value);
    }
  }

  function disconnect() {
    observer?.disconnect();
    targets = [];
  }
  return { update };
}

type BackgroundImageRequest = {
  identity: string;
  context: ApplicationContext;
  client: ApplicationContext["gateway"]["snapshot"]["client"];
  controller: AbortController;
  url: string | null;
};

const FULL_BLEED_MAX_OPACITY = 0.7;

function backgroundSourceForSurface(
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
export function SessionBackgroundContent(
  props: SessionBackgroundProps & { host: SessionBackground },
) {
  // oxlint-disable-next-line solid/reactivity -- The bridge binds this renderer to one native host for its lifetime.
  const host = props.host;
  const inheritedContext = useOptionalApplication();
  const context = () => props.context ?? inheritedContext;
  const fadeLayout = createBackgroundFadeLayout(host);
  const [revision, setRevision] = createSignal(0);
  const notify = () => setRevision((value) => value + 1);
  const [image, setImage] = createSignal<string>();
  let imageElement: HTMLImageElement | undefined;
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
  const syncSurface = (surfaceKind: SessionBackgroundSurface) => {
    const surface =
      host.isConnected && surfaceKind !== "preview"
        ? host.closest<HTMLElement>(".new-session-page, .sidebar-region")
        : null;
    if (surfaceElement !== surface) {
      surfaceElement?.removeAttribute("data-background-custom");
      surfaceElement?.removeAttribute("data-background-painted");
      surfaceElement = surface;
    }
    surface?.toggleAttribute("data-background-custom", host.hasAttribute("data-custom"));
    surface?.toggleAttribute("data-background-painted", host.hasAttribute("data-painted"));
  };
  const releaseImage = (surface = props.surface) => {
    const prior = request;
    request = null;
    prior?.controller.abort();
    setImage(undefined);
    if (prior?.url) {
      // Clear private pixels in the owner notification, before deferred DOM work.
      imageElement?.removeAttribute("src");
      host.removeAttribute("data-painted");
      syncSurface(surface);
      URL.revokeObjectURL(prior.url);
    }
  };
  const retireChangedImage = (
    application: ApplicationContext | undefined,
    identity: string | null,
    surface: SessionBackgroundSurface,
  ) => {
    if (
      request &&
      (request.context !== application ||
        request.client !== application?.gateway.snapshot.client ||
        request.identity !== identity)
    ) {
      releaseImage(surface);
    }
  };
  const contextProjection = createMemo(() =>
    projectSource(context(), {
      read: (application) => application,
      equality: "revision",
      subscribe: (application, publish) => {
        const changed = () => {
          retireChangedImage(context(), currentIdentity(), props.surface);
          publish();
        };
        const cleanups = [
          application?.theme.subscribe(changed),
          application?.gateway.subscribe(changed),
        ];
        return () => cleanups.forEach((cleanup) => cleanup?.());
      },
    }),
  );
  onSettled(() =>
    subscribeBrowserAuthRestored(() => {
      if (!request?.url) {
        failedIdentity = null;
        releaseImage();
        notify();
      }
    }),
  );
  onSettled(() => {
    const stopTheme = observeDocumentRootAttributes(
      host.ownerDocument,
      ["data-theme", "data-theme-mode", "data-theme-background"],
      notify,
    );
    const stopAccessibility =
      accessibility &&
      listen(accessibility, "change", () => {
        releaseImage();
        notify();
      });
    // A warm lazy renderer can settle before its host joins the outer Solid tree.
    queueMicrotask(() => {
      if (host.isConnected) {
        notify();
      }
    });
    return () => {
      stopTheme();
      stopAccessibility?.();
      request?.controller.abort();
      if (request?.url) {
        URL.revokeObjectURL(request.url);
      }
      request = null;
      surfaceElement?.removeAttribute("data-background-custom");
      surfaceElement?.removeAttribute("data-background-painted");
    };
  });
  const view = createMemo(() => {
    revision();
    contextProjection().revision();
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
    // Plugin artwork is pre-dimmed like an upload; only bundled art needs the Full bleed cap.
    const pluginArtwork = host.ownerDocument.documentElement.dataset.themeBackground === "plugin";
    const opacity =
      source?.kind === "theme"
        ? fullBleed && !pluginArtwork
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
      layoutTargets: props.layoutTargets,
    };
  });
  createEffect(
    () => ({ ...view(), image: image() }),
    (state) => {
      host.setAttribute("aria-hidden", "true");
      host.setAttribute("data-presentation", state.fullBleed ? "full-bleed" : "faded");
      host.setAttribute("data-surface", state.surface);
      host.toggleAttribute("data-custom", state.visible && state.source?.kind === "custom");
      retireChangedImage(state.context, state.identity, state.surface);
      host.toggleAttribute(
        "data-painted",
        Boolean(
          state.visible &&
          state.opacity > 0 &&
          (state.source?.kind === "theme" || (state.source?.kind === "custom" && state.image)),
        ),
      );
      syncSurface(state.surface);
      fadeLayout.update(
        (state.surface === "new-session" || state.surface === "preview") &&
          state.visible &&
          Boolean(state.source && state.source.kind !== "none") &&
          !state.fullBleed,
        state.layoutTargets,
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
        // The reader rechecks gateway/profile identity; this effect retires presentation changes.
        isCurrent: () => host.isConnected && request === pending,
      })
        .then((url) => {
          if (request !== pending || !host.isConnected || currentIdentity() !== pending.identity) {
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
            ref={(element) => (imageElement = element)}
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
}
