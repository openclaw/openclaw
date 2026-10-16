import type {
  SessionsFilesDownloadParams,
  SessionsFilesDownloadResult,
} from "../../../packages/gateway-protocol/src/schema/sessions.js";
import { normalizeBasePath } from "../app-route-paths.ts";
import { isSameOriginGateway } from "../app/gateway-control-ui-reload.ts";
import { isHttpArtifactDownloadUrl } from "./artifact-download.ts";
import type { GatewayBrowserClient } from "./gateway.ts";

type FileDownloadHost = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  connectionEpoch: number;
  sessionKey: string;
  resourceBasePath?: string;
};

export type SessionFileDownload = Pick<SessionsFilesDownloadResult, "url" | "filename">;

/** Files chooses and authorizes the bytes; the browser never converts a preview into a download. */
export async function downloadSessionFile(
  state: FileDownloadHost,
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
  if (!isSameOriginGateway(client.gatewayUrl)) {
    throw new Error("File downloads require a same-origin Gateway connection.");
  }
  const result = await client.request<SessionsFilesDownloadResult>(
    "sessions.files.download",
    params,
  );
  if (!current()) {
    return null;
  }
  const url = normalizeBasePath(resourceBasePath ?? "") + result.url;
  if (!isHttpArtifactDownloadUrl(url, resourceBasePath)) {
    throw new Error("Invalid file download URL");
  }
  return { url, filename: result.filename };
}
