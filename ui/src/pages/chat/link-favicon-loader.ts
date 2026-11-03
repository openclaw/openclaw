import { resolveControlUiAuthCandidates } from "../../app/control-ui-auth.ts";
import { hasSameOriginGatewayTransport } from "../../dev-gateway.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { fetchLinkFaviconBlobUrl } from "../plugins/icon-loader.ts";
import { observeChatAttachmentViewport } from "./components/chat-attachment-viewport.ts";
import {
  createLinkFaviconReader,
  hasLinkFavicon,
  type LinkFaviconFetcher,
} from "./link-favicon-cache.ts";

let currentFetcher:
  | {
      authCandidates: string[];
      resourceBasePath: string;
      gatewayUrl: string;
      fetcher: LinkFaviconFetcher;
    }
  | undefined;

export function resolveChatLinkFaviconFetcher(
  state: Parameters<typeof fetchLinkFaviconBlobUrl>[0]["auth"] & {
    automaticallyFetchFavicons: boolean;
    resourceBasePath: string;
    settings: { gatewayUrl: string };
    client: { gatewayUrl: string } | null;
  },
): LinkFaviconFetcher | undefined {
  const gatewayUrl = state.client?.gatewayUrl ?? state.settings.gatewayUrl;
  if (!state.automaticallyFetchFavicons || !hasSameOriginGatewayTransport(gatewayUrl)) {
    return undefined;
  }
  const params = {
    authCandidates: resolveControlUiAuthCandidates(state),
    resourceBasePath: state.resourceBasePath,
    gatewayUrl,
  };
  if (
    currentFetcher?.resourceBasePath === params.resourceBasePath &&
    currentFetcher.gatewayUrl === params.gatewayUrl &&
    currentFetcher.authCandidates.length === params.authCandidates.length &&
    currentFetcher.authCandidates.every((value, index) => value === params.authCandidates[index])
  ) {
    return currentFetcher.fetcher;
  }
  const fetcher: LinkFaviconFetcher = (hostname, signal) =>
    fetchLinkFaviconBlobUrl({ ...params, auth: {}, hostname, signal });
  currentFetcher = { ...params, fetcher };
  return fetcher;
}

const hydratedRoots = new WeakMap<
  ParentNode,
  { fetcher: LinkFaviconFetcher; images: Map<HTMLImageElement, () => void> }
>();

export function releaseLinkFavicons(root: ParentNode): void {
  const hydrated = hydratedRoots.get(root);
  hydratedRoots.delete(root);
  for (const release of hydrated?.images.values() ?? []) {
    release();
  }
}

export function hydrateLinkFavicons(root: ParentNode, fetchFavicon?: LinkFaviconFetcher): void {
  let hydrated = hydratedRoots.get(root);
  if (hydrated?.fetcher !== fetchFavicon) {
    releaseLinkFavicons(root);
    hydrated = undefined;
  }
  if (!fetchFavicon) {
    return;
  }
  if (!hydrated) {
    hydrated = { fetcher: fetchFavicon, images: new Map() };
    hydratedRoots.set(root, hydrated);
  }
  for (const [image, release] of hydrated.images) {
    if (!root.contains(image)) {
      hydrated.images.delete(image);
      release();
    }
  }
  // Markdown owns these image nodes; this hydrator supplies their one-shot load/error state.
  for (const image of root.querySelectorAll<HTMLImageElement>(
    "img.markdown-link-favicon[data-link-favicon-host]",
  )) {
    if (hydrated.images.has(image)) {
      continue;
    }
    const hostname = image.dataset.linkFaviconHost?.trim();
    if (!hostname) {
      image.dataset.linkFaviconState = "failed";
      continue;
    }
    const settled = new AbortController();
    const reader = createLinkFaviconReader(() => apply());
    const apply = () => {
      const blobUrl = reader.read(hostname, fetchFavicon);
      if (blobUrl === undefined) {
        return;
      }
      if (!blobUrl) {
        image.dataset.linkFaviconState = "failed";
        return;
      }
      if (!image.isConnected) {
        return;
      }
      listen(
        image,
        "load",
        () => {
          settled.abort();
          if (image.naturalWidth > 0) {
            image.classList.add("is-loaded");
            image.dataset.linkFaviconState = "loaded";
          }
        },
        { signal: settled.signal },
      );
      listen(
        image,
        "error",
        () => {
          settled.abort();
          image.dataset.linkFaviconState = "failed";
        },
        { signal: settled.signal },
      );
      image.src = blobUrl;
    };
    let stopObserving: (() => void) | undefined;
    const load = () => {
      image.dataset.linkFaviconState = "loading";
      apply();
    };
    // Reusing admitted work needs no second viewport wait on row remounts.
    if (hasLinkFavicon(hostname, fetchFavicon)) {
      load();
    } else {
      stopObserving = observeChatAttachmentViewport(image, load);
    }
    hydrated.images.set(image, () => {
      stopObserving?.();
      settled.abort();
      reader.dispose();
      image.removeAttribute("src");
      image.classList.remove("is-loaded");
      delete image.dataset.linkFaviconState;
    });
  }
}
