import { ARTIFACT_DOWNLOAD_PATH } from "../../../packages/gateway-protocol/src/artifact-download.ts";
import { normalizeBasePath } from "../app-route-paths.ts";
import { fetchControlUiResource } from "../app/browser-http.ts";
import { isSameOriginGateway } from "../app/gateway-control-ui-reload.ts";
import type { GatewayBrowserClient } from "./gateway.ts";
import type { ArtifactDownloadResult } from "./types.ts";

type ArtifactDownloadHost = {
  connected: boolean;
  client?: GatewayBrowserClient | null;
  connectionEpoch?: number;
  resourceBasePath?: string;
};

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

export async function downloadArtifact(
  state: ArtifactDownloadHost,
  params: { sessionKey: string; agentId?: string; artifactId: string },
  signal?: AbortSignal,
  options?: { readBinary?: boolean },
): Promise<(ArtifactDownloadResult & { blob?: Blob }) | null> {
  const client = state.client;
  const connectionEpoch = state.connectionEpoch;
  const resourceBasePath = state.resourceBasePath;
  if (!state.connected || !client) {
    return null;
  }
  // A loaded HTTPS Control UI proves this origin serves ordinary HTTP traffic.
  // A remote wss endpoint alone may expose only WebSocket upgrades.
  const useHttp =
    !/^artifact_managed_(?:image|media)_/u.test(params.artifactId) &&
    globalThis.location?.protocol === "https:" &&
    isSameOriginGateway(client.gatewayUrl);
  const isCurrent = () =>
    !signal?.aborted &&
    state.connected &&
    state.client === client &&
    state.connectionEpoch === connectionEpoch;
  const request = async (http: boolean) => {
    if (!isCurrent()) {
      return null;
    }
    const result = await client.request<ArtifactDownloadResult | null>(
      "artifacts.download",
      { ...params, ...(http ? { transport: "http" } : {}) },
      { timeoutMs: 30_000 },
    );
    return isCurrent() ? result : null;
  };
  const result = await request(useHttp);
  if (!result) {
    return null;
  }
  const url = result.url?.trim();
  if (!useHttp || !url?.startsWith(ARTIFACT_DOWNLOAD_PATH)) {
    return result;
  }
  const download = { ...result, url: `${normalizeBasePath(resourceBasePath ?? "")}${url}` };
  const mimeType = result.artifact.mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!options?.readBinary && !/^(?:image\/|text\/|application\/json$)/u.test(mimeType)) {
    return download;
  }
  try {
    if (!isHttpArtifactDownloadUrl(download.url, resourceBasePath)) {
      throw new Error("Invalid artifact download URL");
    }
    const deadline = AbortSignal.timeout(30_000);
    const response = await fetchControlUiResource(download.url, {
      credentials: "same-origin",
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    if (!response.ok) {
      throw new Error(`Artifact download failed (${response.status})`);
    }
    if (
      response.headers.get("content-disposition")?.split(";", 1)[0]?.trim().toLowerCase() !==
      "attachment"
    ) {
      throw new Error("Artifact download returned an unexpected content disposition");
    }
    const blob = await response.blob();
    if (
      blob.type.split(";", 1)[0]?.trim().toLowerCase() !== (mimeType || "application/octet-stream")
    ) {
      throw new Error("Artifact download returned an unexpected content type");
    }
    return isCurrent() ? { ...download, blob } : null;
  } catch {
    // Some proxies serve the UI and WebSocket but omit media routes. Reauthorize
    // inline delivery on the same connection instead of probing or retargeting.
    return await request(false);
  }
}
