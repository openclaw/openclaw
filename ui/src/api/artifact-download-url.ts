import { ARTIFACT_DOWNLOAD_PATH } from "../../../packages/gateway-protocol/src/artifact-download.ts";
import { normalizeBasePath } from "../app-route-paths.ts";

export function isHttpArtifactDownloadUrl(url: string, resourceBasePath = ""): boolean {
  try {
    const parsed = new URL(url, globalThis.location.origin);
    const prefix = `${normalizeBasePath(resourceBasePath)}${ARTIFACT_DOWNLOAD_PATH}`;
    return (
      parsed.origin === globalThis.location.origin &&
      parsed.pathname.startsWith(prefix) &&
      /^[^/]+\/[^/]+$/u.test(parsed.pathname.slice(prefix.length))
    );
  } catch {
    return false;
  }
}
