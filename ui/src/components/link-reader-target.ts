import type { ControlUiLinkReaderDescriptor } from "../../../src/shared/control-ui-link-reader.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { composedParent } from "../lib/navigation-click.ts";
import {
  isGitHubHost,
  isGitHubPublicPageUrl,
  matchGitHubItemUrl,
} from "./github-link-eligibility.ts";

export const LINK_READER_HOVERCARD_OPEN_DELAY_MS = 250;
export const LINK_READER_HOVERCARD_PROVIDER_TAG = "openclaw-link-reader-hovercard-provider";

export type LinkReaderTarget = { href: string; reader: ControlUiLinkReaderDescriptor };
export const EMPTY_LINK_READERS: readonly ControlUiLinkReaderDescriptor[] = [];
const patterns = new WeakMap<ControlUiLinkReaderDescriptor, RegExp | null>();

/** Installed plugins declare exact HTTPS hosts and bounded, anchored pathname patterns. */
export function resolveLinkReaderTarget(
  value: string,
  readers: readonly ControlUiLinkReaderDescriptor[],
): LinkReaderTarget | null {
  if (!value || value.length > 8192) {
    return null;
  }
  const url = URL.parse(value);
  if (!url || url.protocol !== "https:" || url.username || url.password || url.port) {
    return null;
  }
  for (const reader of readers) {
    if (!reader.linkReader.hosts.includes(url.hostname)) {
      continue;
    }
    let pattern = patterns.get(reader);
    if (pattern === undefined) {
      try {
        pattern = new RegExp(reader.linkReader.pathPattern, "u");
      } catch {
        pattern = null;
      }
      patterns.set(reader, pattern);
    }
    if (pattern?.test(url.pathname)) {
      return { href: url.href, reader };
    }
  }
  return null;
}

export function linkReaderTargetKey(target: LinkReaderTarget): string {
  // The resolver already canonicalized href; only the fragment is non-identity.
  return target.reader.pluginId + ":" + target.reader.id + ":" + target.href.split("#", 1)[0];
}

export type PageHoverTarget = { kind: "page"; href: string; reader?: undefined };
export type HoverPreviewTarget = LinkReaderTarget | PageHoverTarget;
export type HoverPreviewOwner = {
  client: GatewayBrowserClient | null;
  readers: readonly ControlUiLinkReaderDescriptor[];
  claimedReaders?: readonly ControlUiLinkReaderDescriptor[];
  pagePreviewContext?: ApplicationContext;
};

export function isPreviewAnchor(anchor: HTMLAnchorElement): boolean {
  const url = URL.parse(anchor.href);
  // Repositories and public information pages use anonymous social metadata.
  // Account/auth URLs stay unfetched.
  // Hover, focus, and prefetch share this gate.
  if (
    url &&
    isGitHubHost(url.hostname) &&
    !matchGitHubItemUrl(url) &&
    !isGitHubPublicPageUrl(url)
  ) {
    return false;
  }
  if (
    anchor.matches(
      "[download], [data-file-path], [data-session-href], .markdown-session-link, [data-link-reader-external]",
    )
  ) {
    return false;
  }
  for (let element: Element | null = anchor; element; element = composedParent(element)) {
    if (
      element.matches(
        "openclaw-tooltip, openclaw-browser-tab-card, wa-popover, .link-reader-hovercard, .link-hovercard, .session-progress-hovercard, .chat-source-card",
      )
    ) {
      return false;
    }
  }
  return true;
}

export function canPreviewPages(owner: HoverPreviewOwner): boolean {
  const context = owner.pagePreviewContext;
  return Boolean(
    context?.config.current.automaticallyFetchFavicons &&
    context.gateway.snapshot.client === owner.client &&
    canCallGatewayMethod(context.gateway.snapshot, "controlUi.linkPreview", "operator.read", {
      requireAdvertisement: false,
    }),
  );
}

/** Plugin claims include detail-only readers; public metadata never overrides them. */
export function resolveHoverPreviewTarget(
  anchor: HTMLAnchorElement,
  owner: HoverPreviewOwner,
): HoverPreviewTarget | null {
  if (!owner.client || !isPreviewAnchor(anchor)) {
    return null;
  }
  const claimed = resolveLinkReaderTarget(
    anchor.href,
    owner.claimedReaders?.length ? owner.claimedReaders : owner.readers,
  );
  if (claimed) {
    return claimed.reader.linkReader.previewMethod && owner.readers.includes(claimed.reader)
      ? claimed
      : null;
  }
  if (!canPreviewPages(owner)) {
    return null;
  }
  const url = URL.parse(anchor.href);
  return url &&
    ["http:", "https:"].includes(url.protocol) &&
    url.origin !== location.origin &&
    !url.username &&
    !url.password &&
    url.href.length <= 2048
    ? { kind: "page", href: url.href }
    : null;
}
