import { isBlockedRemoteMediaIpHostname } from "./remote-media-host-ip.js";
// Server entry: install the full IP literal guard synchronously before any parse.
// Browser bundles import parse-output-core.ts and load the guard on demand.
import { installRemoteMediaIpHostnameGuard } from "./remote-media-host.js";

installRemoteMediaIpHostnameGuard(isBlockedRemoteMediaIpHostname);

export { isRelativeAssistantMediaReference, splitMediaOutput } from "./parse-output-core.js";
