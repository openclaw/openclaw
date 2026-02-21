import { startCloudflaredTunnel } from "../infra/cloudflared.js";

export async function startGatewayCloudflareExposure(params: {
  cloudflareMode: "off" | "managed" | "access-only";
  tunnelToken?: string;
  controlUiBasePath?: string;
  logCloudflare: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}): Promise<(() => Promise<void>) | null> {
  if (params.cloudflareMode === "off") {
    return null;
  }

  if (params.cloudflareMode === "access-only") {
    params.logCloudflare.info(
      "access-only mode: Cloudflare Access JWT verification active (external cloudflared expected)",
    );
    return null;
  }

  // managed mode — spawn cloudflared tunnel run
  if (!params.tunnelToken) {
    params.logCloudflare.error("managed mode: no tunnel token provided, skipping tunnel start");
    return null;
  }

  try {
    const tunnel = await startCloudflaredTunnel({
      token: params.tunnelToken,
      timeoutMs: 30_000,
    });
    params.logCloudflare.info(
      `managed tunnel running (connectorId=${tunnel.connectorId ?? "unknown"}, pid=${tunnel.pid ?? "unknown"})`,
    );
    return tunnel.stop;
  } catch (err) {
    params.logCloudflare.error(
      `managed tunnel failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
