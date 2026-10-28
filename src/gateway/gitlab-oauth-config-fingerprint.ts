import { createHash } from "node:crypto";
import type { GitLabOAuthConfig } from "../agents/gitlab-host.js";

/** Change marker for public application metadata, never a password or token hash. */
export function fingerprintGitLabOAuthConfig(config: GitLabOAuthConfig): string {
  // Keep this allowlist explicit: clientId is public OAuth application metadata.
  const publicMetadata = {
    issuer: config.issuer,
    clientId: config.clientId,
    redirectUri: config.redirectUri,
  };
  return createHash("sha256").update(JSON.stringify(publicMetadata)).digest("hex");
}
