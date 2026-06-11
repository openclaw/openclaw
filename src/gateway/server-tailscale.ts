import type { GatewayTailscaleConfig } from "../config/types.gateway.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  disableTailscaleFunnel,
  enableTailscaleFunnel,
  enableTailscaleServe,
  getTailnetHostname,
  hasTailscaleFunnelRouteForPort,
  verifyTailscaleServeRouteForPort,
} from "../infra/tailscale.js";

export async function startGatewayTailscaleExposure(params: {
  tailscaleMode: "off" | "serve" | "funnel";
  tailscaleConfig?: GatewayTailscaleConfig;
  resetOnExit?: boolean;
  port: number;
  preserveFunnel?: boolean;
  controlUiBasePath?: string;
  logTailscale: { info: (msg: string) => void; warn: (msg: string) => void };
}): Promise<(() => Promise<void>) | null> {
  if (params.tailscaleMode === "off") {
    return null;
  }

  const tailscaleRequired = params.tailscaleConfig?.required ?? true;
  const tailscaleClientOptions = {
    binaryPath: params.tailscaleConfig?.binaryPath,
    socketPath: params.tailscaleConfig?.socketPath,
  };

  try {
    if (params.tailscaleMode === "serve") {
      if (params.preserveFunnel === true) {
        const funnelCovers = await hasTailscaleFunnelRouteForPort(
          params.port,
          undefined,
          tailscaleClientOptions,
        );
        if (funnelCovers) {
          const resetSuffix = params.resetOnExit
            ? "; resetOnExit is a no-op because no Serve route was applied this run"
            : "";
          params.logTailscale.info(
            `serve skipped: preserving externally configured Tailscale Funnel for port ${params.port}${resetSuffix}`,
          );
          // Skip the resetOnExit teardown deliberately: the Funnel route is
          // owned by an external operator, so we must not run
          // disableTailscaleServe on shutdown either.
          return null;
        }
      }
      await enableTailscaleServe(params.port, undefined, tailscaleClientOptions);
      const verified = await verifyTailscaleServeRouteForPort(
        params.port,
        undefined,
        tailscaleClientOptions,
      );
      if (!verified.ok) {
        throw new Error(
          `Tailscale Serve route verification failed: ${verified.reason ?? "unknown route mismatch"}`,
        );
      }
    } else {
      await enableTailscaleFunnel(params.port, undefined, tailscaleClientOptions);
      const funnelCovers = await hasTailscaleFunnelRouteForPort(
        params.port,
        undefined,
        tailscaleClientOptions,
      );
      if (!funnelCovers) {
        throw new Error(
          `Tailscale Funnel route verification failed: no published route points at Gateway port ${params.port}`,
        );
      }
    }
    const host = await getTailnetHostname(undefined, tailscaleClientOptions).catch(() => null);
    if (host) {
      const uiPath = params.controlUiBasePath ? `${params.controlUiBasePath}/` : "/";
      params.logTailscale.info(
        `${params.tailscaleMode} enabled: https://${host}${uiPath} (WS via wss://${host})`,
      );
    } else {
      params.logTailscale.info(`${params.tailscaleMode} enabled`);
    }
  } catch (err) {
    const message = `${params.tailscaleMode} failed: ${formatErrorMessage(err)}`;
    params.logTailscale.warn(message);
    if (tailscaleRequired) {
      throw new Error(
        `${message}. gateway.tailscale.mode=${params.tailscaleMode} is required; set gateway.tailscale.required=false to allow degraded startup.`,
        { cause: err },
      );
    }
  }

  if (!params.resetOnExit) {
    return null;
  }

  return async () => {
    try {
      if (params.tailscaleMode === "serve") {
        params.logTailscale.warn(
          "serve cleanup skipped: OpenClaw no longer runs broad `tailscale serve reset` on shutdown because it can delete unrelated Serve routes. Leave the verified route in place or clear it manually after confirming ownership.",
        );
      } else {
        await disableTailscaleFunnel(undefined, tailscaleClientOptions);
      }
    } catch (err) {
      params.logTailscale.warn(
        `${params.tailscaleMode} cleanup failed: ${formatErrorMessage(err)}`,
      );
    }
  };
}
