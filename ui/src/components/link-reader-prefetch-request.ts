import { linkReaderHovercardBootstrap as bootstrap } from "./link-reader-hovercard-registration.ts";
import { isPreviewAnchor, resolveLinkReaderTarget } from "./link-reader-target.ts";

export function previewTargetForAnchor(anchor: HTMLAnchorElement) {
  if (!isPreviewAnchor(anchor)) {
    return null;
  }
  const provider = bootstrap.providerFor(anchor);
  const target =
    provider?.client && provider.readers
      ? resolveLinkReaderTarget(anchor.href, provider.readers)
      : null;
  return target?.reader.linkReader.previewMethod ? target : null;
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
