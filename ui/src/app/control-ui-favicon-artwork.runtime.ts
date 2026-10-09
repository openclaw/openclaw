import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { registerAvatarGatewayReset } from "../lib/identity-avatar-context.ts";
import { resolveAvatarImageUrl, retainAvatarImageUrl } from "../lib/identity-avatar-loader.ts";
import type { ApplicationContext } from "./context.ts";
import { applyControlUiFaviconImage } from "./control-ui-environment-presentation.runtime.ts";
import { gatewayPresentationScope } from "./gateway-presentation-scope.ts";

// Artwork consumes invalidation only, not payloads that some stores also publish.
type ChangeSource = { subscribe: (listener: () => void) => () => void };

/** Personal artwork follows its source; the status owner remains independent. */
export function connectControlUiFaviconArtwork(context: {
  gateway: ApplicationContext["gateway"];
  theme: ChangeSource & {
    settings: Pick<ApplicationContext["theme"]["settings"], "tabIcon">;
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
    const mode = context.theme.settings.tabIcon ?? "default";
    const lobsterId = mode.startsWith("lobster:") ? mode.slice("lobster:".length) : null;
    if (!lobsterId) {
      stopLobsterdex?.();
      stopLobsterdex = undefined;
    }
    const agentId = context.agentSelection.state.selectedId;
    const agent = context.agents.state.agentsList?.agents.find((entry) => entry.id === agentId);
    if (mode === "agent" && agentId && context.gateway.snapshot.phase === "connected") {
      void context.agentIdentity.ensure([agentId]);
    }
    const source =
      mode === "agent" && agent
        ? resolveAgentAvatarUrl(agent, context.agentIdentity.get(agentId))
        : null;
    const nextKey = JSON.stringify([
      scope.key,
      mode,
      mode === "agent" ? agentId : null,
      source,
      mode === "agent" ? avatarRevision : lobsterId ? lobsterRevision : null,
    ]);
    if (sourceKey === nextKey) {
      return;
    }
    sourceKey = nextKey;
    retireImage();
    if (!lobsterId && (mode !== "agent" || !source)) {
      applyControlUiFaviconImage(null);
      return;
    }
    // Never leave the previous agent's image visible while the new identity resolves.
    applyControlUiFaviconImage(null);
    const generation = request;
    const current = () =>
      !disposed && generation === request && scope === gatewayPresentationScope(context.gateway);
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
            applyControlUiFaviconImage(image);
          }
        })
        .catch(() => {
          if (current()) {
            sourceKey = "";
            applyControlUiFaviconImage(null);
          }
        });
      return;
    }
    if (!source) {
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
        const image = new Image();
        image.src = url;
        await image.decode();
        if (!current()) {
          return;
        }
        if (!image.naturalWidth || !image.naturalHeight) {
          throw new Error("Agent avatar has no dimensions");
        }
        applyControlUiFaviconImage(image);
      })
      .catch(() => {
        if (current()) {
          // Retry a failed source on the next publication, without a timer or a stale lease.
          sourceKey = "";
          retireImage();
          applyControlUiFaviconImage(null);
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
