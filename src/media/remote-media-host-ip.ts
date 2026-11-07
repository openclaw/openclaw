import * as netPolicyIp from "@openclaw/net-policy/ip";
import { createRemoteMediaIpHostnameGuard } from "./remote-media-host.js";

/** Full MEDIA: host guard for a normalized host, including IP literal parsing. */
export const isBlockedRemoteMediaIpHostname = createRemoteMediaIpHostnameGuard(netPolicyIp);
