import type {
  SessionsFilesDownloadParams,
  SessionsFilesDownloadResult,
} from "../../../packages/gateway-protocol/src/schema/sessions.js";
import { normalizeBasePath } from "../app-route-paths.ts";
import { hasSameOriginGatewayTransport } from "../dev-gateway.ts";
import { t } from "../i18n/index.ts";
import { isHttpArtifactDownloadUrl } from "./artifact-download-url.ts";
import type { GatewayBrowserClient } from "./gateway.ts";

export type SessionFileDownload = Pick<SessionsFilesDownloadResult, "url" | "filename">;

/** Files chooses and authorizes the bytes; the browser never converts a preview into a download. */
// Download UI callers own registration of the lazy file-preview catalog.
export async function downloadSessionFile(
  state: {
    client: GatewayBrowserClient | null;
    connected: boolean;
    connectionEpoch: number;
    sessionKey: string;
    resourceBasePath?: string;
  },
  params: SessionsFilesDownloadParams,
  signal: AbortSignal,
): Promise<SessionFileDownload | null> {
  const { client, connectionEpoch, sessionKey, resourceBasePath } = state;
  const current = () =>
    !signal.aborted &&
    state.connected &&
    state.client === client &&
    state.connectionEpoch === connectionEpoch &&
    state.sessionKey === sessionKey;
  if (!client || !current()) {
    return null;
  }
  if (!hasSameOriginGatewayTransport(client.gatewayUrl)) {
    throw new Error(t("chat.detailPanel.sameOrigin"));
  }
  const result = await client.request<SessionsFilesDownloadResult>(
    "sessions.files.download",
    params,
    { signal },
  );
  if (!current()) {
    return null;
  }
  const url = normalizeBasePath(resourceBasePath ?? "") + result.url;
  if (!isHttpArtifactDownloadUrl(url, resourceBasePath)) {
    throw new Error(t("chat.detailPanel.invalidUrl"));
  }
  return { url, filename: result.filename };
}
