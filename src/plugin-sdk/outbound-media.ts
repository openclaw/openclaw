import { buildOutboundMediaLoadOptions, type OutboundMediaAccess } from "../media/load-options.js";
import { loadWebMedia } from "./web-media.js";

export type OutboundMediaLoadOptions = {
  /** Maximum accepted media size before channel-specific upload handling. */
  maxBytes?: number;
  /** Pre-resolved host read capability; overrides mediaReadFile/local roots when supplied. */
  mediaAccess?: OutboundMediaAccess;
  /** Local roots allowed for file/path media, or "any" for explicit host opt-in. */
  mediaLocalRoots?: readonly string[] | "any";
  /** Host-provided file reader used only when explicit local roots are present. */
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  /** Workspace base used by shared web-media path resolution. */
  workspaceDir?: string;
  /** Optional proxy used for remote media fetches. */
  proxyUrl?: string;
  /** Fetch implementation injected by plugins/tests instead of global fetch. */
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Request init forwarded to the remote media fetch. */
  requestInit?: RequestInit;
  /** Treat explicit proxy DNS resolution as trusted for SSRF checks. */
  trustExplicitProxyDns?: boolean;
};

/** Load outbound media from a remote URL or approved local path using the shared web-media policy. */
export async function loadOutboundMediaFromUrl(
  mediaUrl: string,
  options: OutboundMediaLoadOptions = {},
) {
  return await loadWebMedia(
    mediaUrl,
    buildOutboundMediaLoadOptions({
      maxBytes: options.maxBytes,
      mediaAccess: options.mediaAccess,
      mediaLocalRoots: options.mediaLocalRoots,
      mediaReadFile: options.mediaReadFile,
      workspaceDir: options.workspaceDir,
      proxyUrl: options.proxyUrl,
      fetchImpl: options.fetchImpl,
      requestInit: options.requestInit,
      trustExplicitProxyDns: options.trustExplicitProxyDns,
    }),
  );
}
