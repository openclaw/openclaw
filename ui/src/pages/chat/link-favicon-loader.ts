import { resolveControlUiAuthCandidates } from "../../app/control-ui-auth.ts";
import { hasSameOriginGatewayTransport } from "../../dev-gateway.ts";
import { fetchLinkFaviconBlobUrl } from "../plugins/icon-loader.ts";
import { readLinkFavicon, type LinkFaviconFetcher } from "./link-favicon-cache.ts";

let currentFetcher:
  | {
      authCandidates: string[];
      resourceBasePath: string;
      gatewayUrl: string;
      fetcher: LinkFaviconFetcher;
    }
  | undefined;

function createLinkFaviconFetcher(params: {
  authCandidates: string[];
  resourceBasePath: string;
  gatewayUrl: string;
}): LinkFaviconFetcher {
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

export function resolveChatLinkFaviconFetcher(
  state: Parameters<typeof fetchLinkFaviconBlobUrl>[0]["auth"] & {
    automaticallyFetchFavicons: boolean;
    resourceBasePath: string;
    settings: { gatewayUrl: string };
    client: { gatewayUrl: string } | null;
  },
): LinkFaviconFetcher | undefined {
  const gatewayUrl = state.client?.gatewayUrl ?? state.settings.gatewayUrl;
  return state.automaticallyFetchFavicons && hasSameOriginGatewayTransport(gatewayUrl)
    ? createLinkFaviconFetcher({
        authCandidates: resolveControlUiAuthCandidates(state),
        resourceBasePath: state.resourceBasePath,
        gatewayUrl,
      })
    : undefined;
}

export function hydrateLinkFavicons(root: ParentNode, fetchFavicon?: LinkFaviconFetcher): void {
  if (!fetchFavicon) {
    return;
  }
  for (const image of root.querySelectorAll<HTMLImageElement>(
    "img.markdown-link-favicon[data-link-favicon-host]",
  )) {
    if (image.dataset.linkFaviconState) {
      continue;
    }
    const hostname = image.dataset.linkFaviconHost?.trim();
    if (!hostname) {
      image.dataset.linkFaviconState = "failed";
      continue;
    }
    image.dataset.linkFaviconState = "loading";
    const apply = () => {
      const blobUrl = readLinkFavicon(hostname, fetchFavicon, apply);
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
      image.addEventListener(
        "load",
        () => {
          if (image.naturalWidth > 0) {
            image.classList.add("is-loaded");
            image.dataset.linkFaviconState = "loaded";
          }
        },
        { once: true },
      );
      image.addEventListener(
        "error",
        () => {
          image.dataset.linkFaviconState = "failed";
        },
        { once: true },
      );
      image.src = blobUrl;
    };
    apply();
  }
}
