import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { registerAvatarGatewayReset } from "../lib/identity-avatar-context.ts";
import { resolveAvatarImageUrl, retainAvatarImageUrl } from "../lib/identity-avatar-loader.ts";
import type { ApplicationContext } from "./context.ts";
import { applyControlUiFaviconImage } from "./control-ui-environment-presentation.runtime.ts";
import { gatewayPresentationScope } from "./gateway-presentation-scope.ts";

/** Artwork follows explicit agent selection; the status owner remains independent. */
export function connectControlUiFaviconArtwork(context: {
  gateway: ApplicationContext["gateway"];
  theme: Pick<ApplicationContext["theme"], "subscribe"> & {
    settings: Pick<ApplicationContext["theme"]["settings"], "tabIcon">;
  };
  agents: Pick<ApplicationContext["agents"], "subscribe"> & {
    state: Pick<ApplicationContext["agents"]["state"], "agentsList">;
  };
  agentIdentity: Pick<ApplicationContext["agentIdentity"], "get" | "ensure" | "subscribe">;
  agentSelection: Pick<ApplicationContext["agentSelection"], "state" | "subscribe">;
}): () => void {
  let disposed = false;
  let request = 0;
  let sourceKey = "";
  let avatarRevision = 0;
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
    const preference = context.theme.settings.tabIcon;
    const mode = preference?.mode ?? "default";
    const agentId = context.agentSelection.state.selectedId;
    const agent = context.agents.state.agentsList?.agents.find((entry) => entry.id === agentId);
    if (mode === "agent" && agentId && context.gateway.snapshot.phase === "connected") {
      void context.agentIdentity.ensure([agentId]);
    }
    const source =
      mode === "custom"
        ? (preference?.image?.dataUrl ?? null)
        : mode === "agent" && agent
          ? resolveAgentAvatarUrl(agent, context.agentIdentity.get(agentId))
          : null;
    const nextKey = JSON.stringify([
      scope.key,
      mode,
      mode === "agent" ? agentId : null,
      source,
      avatarRevision,
    ]);
    if (sourceKey === nextKey) {
      return;
    }
    sourceKey = nextKey;
    retireImage();
    if (mode !== "agent" || !source) {
      applyControlUiFaviconImage(source);
      return;
    }
    // Never leave the previous agent's image visible while the new identity resolves.
    applyControlUiFaviconImage(null);
    const generation = request;
    const current = () =>
      !disposed && generation === request && scope === gatewayPresentationScope(context.gateway);
    const resolved = source.startsWith("/") ? resolveAvatarImageUrl(source) : source;
    releaseImage = retainAvatarImageUrl(resolved);
    void Promise.resolve(resolved)
      .then(async (url) => {
        if (!url || !current()) {
          return;
        }
        const image = new Image();
        image.src = url;
        await image.decode();
        if (!current()) {
          return;
        }
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 32;
        const drawing = canvas.getContext("2d");
        if (!drawing || !image.naturalWidth || !image.naturalHeight) {
          return;
        }
        const scale = Math.min(32 / image.naturalWidth, 32 / image.naturalHeight);
        const width = image.naturalWidth * scale;
        const height = image.naturalHeight * scale;
        drawing.drawImage(image, (32 - width) / 2, (32 - height) / 2, width, height);
        if (current()) {
          // A self-contained raster favicon does not expose protected avatar routes or blob lifetimes.
          applyControlUiFaviconImage(canvas.toDataURL("image/png"));
        }
      })
      .catch(() => {
        if (current()) {
          applyControlUiFaviconImage(null);
        }
      });
  }

  const stops = [
    context.gateway.subscribe(synchronize),
    context.theme.subscribe(synchronize),
    context.agents.subscribe(synchronize),
    context.agentIdentity.subscribe(synchronize),
    context.agentSelection.subscribe(synchronize),
    registerAvatarGatewayReset(() => {
      avatarRevision += 1;
      retireImage();
      applyControlUiFaviconImage(null);
      // The avatar context publishes its new origin after notifying reset listeners.
      queueMicrotask(synchronize);
    }),
  ];
  synchronize();
  return () => {
    disposed = true;
    stops.forEach((stop) => stop());
    retireImage();
    applyControlUiFaviconImage(null);
  };
}
