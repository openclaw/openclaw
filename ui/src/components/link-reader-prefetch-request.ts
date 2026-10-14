import { linkReaderHovercardBootstrap as bootstrap } from "./link-reader-hovercard-registration.ts";
import {
  isPreviewAnchor,
  resolveLinkReaderTarget,
  type HoverPreviewOwner,
} from "./link-reader-target.ts";

export function resolveLinkReaderPreviewClaim(href: string, readers: HoverPreviewOwner["readers"]) {
  const target = resolveLinkReaderTarget(href, readers);
  return target?.reader.linkReader.previewMethod ? target : null;
}

export function previewTargetForAnchor(
  anchor: HTMLAnchorElement,
  provider = bootstrap.providerFor(anchor),
  resolveClaim = resolveLinkReaderPreviewClaim,
) {
  const target =
    provider?.client && provider.readers ? resolveClaim(anchor.href, provider.readers) : null;
  return target && isPreviewAnchor(anchor) ? target : null;
}

export async function prefetchLinkReader(
  anchor: HTMLAnchorElement,
  signal: AbortSignal,
): Promise<void> {
  const target = previewTargetForAnchor(anchor);
  const owner = bootstrap.providerFor(anchor);
  if (!target || !owner?.client?.connected || signal.aborted) {
    return;
  }
  const { client, agentId, readers } = owner;
  await bootstrap.define();
  const provider = bootstrap.providerFor(anchor);
  await provider?.updateComplete;
  if (
    signal.aborted ||
    !anchor.isConnected ||
    anchor.href !== target.href ||
    document.hidden ||
    provider !== owner ||
    provider.client !== client ||
    provider.agentId !== agentId ||
    provider.readers !== readers
  ) {
    return;
  }
  await provider.prefetch(target, signal);
}
