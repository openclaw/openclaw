import { agentTabIconShape } from "../../../packages/gateway-protocol/src/schema/tab-icon.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { registerAvatarGatewayReset } from "../lib/identity-avatar-context.ts";
import { resolveAvatarImageUrl, retainAvatarImageUrl } from "../lib/identity-avatar-loader.ts";
import type { ApplicationContext } from "./context.ts";
import { applyControlUiFaviconImage } from "./control-ui-environment-presentation.runtime.ts";
import { gatewayPresentationScope } from "./gateway-presentation-scope.ts";

// Artwork consumes invalidation only, not payloads that some stores also publish.
type ChangeSource = { subscribe: (listener: () => void) => () => void };

async function decodeFaviconImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = url;
  await image.decode();
  if (!image.naturalWidth || !image.naturalHeight) {
    throw new Error("Favicon artwork has no dimensions");
  }
  return image;
}

/** Personal and theme artwork share one lifecycle; the status owner remains independent. */
export function connectControlUiFaviconArtwork(context: {
  gateway: ApplicationContext["gateway"];
  theme: ChangeSource & {
    settings: Pick<ApplicationContext["theme"]["settings"], "tabIcon">;
    branding: Pick<ApplicationContext["theme"]["branding"], "lobsterdex" | "brandIcon" | "artwork">;
  };
  agents: ChangeSource & {
    state: Pick<ApplicationContext["agents"]["state"], "agentsList">;
  };
  agentIdentity: Pick<ApplicationContext["agentIdentity"], "get" | "ensure" | "subscribe">;
  agentSelection: ChangeSource & Pick<ApplicationContext["agentSelection"], "state">;
}): () => void {
  let disposed = false;
  let request = 0;
  let sourceKey = "";
  let avatarRevision = 0;
  let lobsterRevision = 0;
  let stopLobsterdex: (() => void) | undefined;
  let releaseImage = () => {};

  function retireImage() {
    request += 1;
    releaseImage();
    releaseImage = () => {};
  }

  function synchronize() {
    if (disposed) {
      return;
    }
    const scope = gatewayPresentationScope(context.gateway);
    const branding = context.theme.branding;
    const themeSource = branding.artwork?.icons?.[branding.brandIcon]?.url;
    const preference = context.theme.settings.tabIcon ?? "default";
    // Theme suppression is presentation-only; switching back restores the saved choice.
    const mode = !branding.lobsterdex && preference.startsWith("lobster:") ? "default" : preference;
    const shape = agentTabIconShape(mode);
    const lobsterId = mode.startsWith("lobster:") ? mode.slice("lobster:".length) : null;
    if (!lobsterId) {
      stopLobsterdex?.();
      stopLobsterdex = undefined;
    }
    const agentId = context.agentSelection.state.selectedId;
    const agent = context.agents.state.agentsList?.agents.find((entry) => entry.id === agentId);
    if (shape !== null && agentId && context.gateway.snapshot.phase === "connected") {
      void context.agentIdentity.ensure([agentId]);
    }
    const source =
      shape !== null && agent
        ? resolveAgentAvatarUrl(agent, context.agentIdentity.get(agentId))
        : null;
    const nextKey = JSON.stringify([
      scope.key,
      mode,
      shape !== null ? agentId : null,
      source,
      themeSource,
      shape !== null ? avatarRevision : lobsterId ? lobsterRevision : null,
    ]);
    if (sourceKey === nextKey) {
      return;
    }
    sourceKey = nextKey;
    retireImage();
    // Never leave the previous agent's image visible while the new identity resolves.
    applyControlUiFaviconImage(null);
    const generation = request;
    const current = () =>
      !disposed && generation === request && scope === gatewayPresentationScope(context.gateway);
    const applyThemeArtwork = async () => {
      if (!themeSource || !current()) {
        return;
      }
      try {
        const { fetchPluginThemeArtworkBlobUrl } = await import("../pages/plugins/icon-loader.ts");
        if (!current()) {
          return;
        }
        const url = await fetchPluginThemeArtworkBlobUrl({ url: themeSource });
        if (!current()) {
          return;
        }
        if (!url) {
          sourceKey = "";
          return;
        }
        const image = await decodeFaviconImage(url);
        if (current()) {
          applyControlUiFaviconImage(image);
        }
      } catch {
        if (current()) {
          sourceKey = "";
          applyControlUiFaviconImage(null);
        }
      }
    };
    if (lobsterId) {
      void Promise.all([
        import("../components/lobster-favicon.ts"),
        import("../components/lobster-dex.ts"),
      ])
        .then(([{ loadUnlockedLobsterFavicon }, { subscribeLobsterdex }]) => {
          if (!current()) {
            return null;
          }
          stopLobsterdex ??= subscribeLobsterdex(() => {
            lobsterRevision += 1;
            synchronize();
          });
          return loadUnlockedLobsterFavicon(lobsterId);
        })
        .then((image) => {
          if (current()) {
            if (image) {
              applyControlUiFaviconImage(image);
            } else {
              void applyThemeArtwork();
            }
          }
        })
        .catch(() => {
          if (current()) {
            sourceKey = "";
            void applyThemeArtwork();
          }
        });
      return;
    }
    if (!source || shape === null) {
      void applyThemeArtwork();
      return;
    }
    const resolved = source.startsWith("/") ? resolveAvatarImageUrl(source) : source;
    releaseImage = retainAvatarImageUrl(resolved);
    void Promise.resolve(resolved)
      .then(async (url) => {
        if (!current()) {
          return;
        }
        if (!url) {
          throw new Error("Agent avatar unavailable");
        }
        const image = await decodeFaviconImage(url);
        if (current()) {
          applyControlUiFaviconImage(image, shape);
        }
      })
      .catch(() => {
        if (current()) {
          // Retry a failed source on the next publication, without a timer or a stale lease.
          sourceKey = "";
          releaseImage();
          releaseImage = () => {};
          void applyThemeArtwork();
        }
      });
  }

  const stops = [
    context.gateway.subscribe(synchronize),
    context.theme.subscribe(() => {
      // Theme publications include applied lazy palettes and system-mode changes,
      // not just preference intent. Re-bake CSS-dependent artwork after either.
      lobsterRevision += 1;
      synchronize();
    }),
    context.agents.subscribe(synchronize),
    context.agentIdentity.subscribe(synchronize),
    context.agentSelection.subscribe(synchronize),
    registerAvatarGatewayReset(() => {
      avatarRevision += 1;
      sourceKey = "";
      retireImage();
      applyControlUiFaviconImage(null);
      // The avatar context publishes its new origin after notifying reset listeners.
      queueMicrotask(synchronize);
    }),
  ];
  synchronize();
  return () => {
    disposed = true;
    stopLobsterdex?.();
    stops.forEach((stop) => stop());
    retireImage();
    applyControlUiFaviconImage(null);
  };
}
