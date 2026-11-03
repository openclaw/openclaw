import type { ControlUiLinkReaderPreview } from "../../../src/shared/control-ui-link-reader.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import {
  linkReaderTargetKey,
  resolveLinkReaderTarget,
  type LinkReaderTarget,
} from "./link-reader-target.ts";

// Response validation loads with reader content, after eager navigation selects a target.
/** Response identity includes the reader and query; an anchor only selects within that document. */
export function linkReaderResponseMatchesTarget(target: LinkReaderTarget, value: unknown): boolean {
  const returned =
    typeof value === "string" ? resolveLinkReaderTarget(value, [target.reader]) : null;
  return returned !== null && linkReaderTargetKey(returned) === linkReaderTargetKey(target);
}

/** Profile links stay with their source service and never execute authored schemes. */
export function linkReaderAuthorHref(value: unknown, source: string): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const url = URL.parse(value, source);
  return url?.protocol === "https:" &&
    !url.username &&
    !url.password &&
    url.origin === URL.parse(source)?.origin
    ? url.href
    : undefined;
}

// Committed reader facts refresh projections, never another identity's cache.
export const LINK_READER_METADATA_UPDATED_EVENT = "openclaw:link-reader-metadata-updated";
export const LINK_READER_METADATA_REQUEST_EVENT = "openclaw:link-reader-metadata-request";
export type LinkReaderMetadataUpdate = {
  client: GatewayBrowserClient;
  agentId: string | undefined;
  sessionKey: string | undefined;
  target: LinkReaderTarget;
  preview: ControlUiLinkReaderPreview;
};
declare global {
  interface WindowEventMap {
    "openclaw:link-reader-metadata-updated": CustomEvent<LinkReaderMetadataUpdate>;
  }
}
