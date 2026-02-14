import {
  disableTailscaleFunnel,
  disableTailscaleServe,
  enableTailscaleFunnel,
  enableTailscaleServe,
} from "../infra/tailscale.js";

export async function startGatewayTailscaleExposure(params: {
  tailscaleMode: "off" | "serve" | "funnel";
  resetOnExit?: boolean;
  port: number;
  controlUiBasePath?: string;
  logTailscale: { info: (msg: string) => void; warn: (msg: string) => void };
}): Promise<(() => Promise<void>) | null> {
  if (params.tailscaleMode === "off") {
    return null;
  }

  try {
    if (params.tailscaleMode === "serve") {
      await enableTailscaleServe(params.port);
    } else {
      await enableTailscaleFunnel(params.port);
    }
    params.logTailscale.info(
      `${params.tailscaleMode} enabled (run \`tailscale status\` to see this machine's hostname)`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stderr =
      typeof (err as { stderr?: string }).stderr === "string"
        ? (err as { stderr: string }).stderr
        : "";
    const full = `${msg}\n${stderr}`.trim();
    const daemonDown =
      /connection refused|not running|dial unix.*connect/i.test(full) ||
      (full.includes("serve") && full.includes("Failed to connect"));
    if (daemonDown) {
      params.logTailscale.info(
        `Tailscale ${params.tailscaleMode} skipped (daemon not running). Gateway is available on LAN/loopback.`,
      );
    } else {
      params.logTailscale.warn(`${params.tailscaleMode} failed: ${msg}`);
    }
  }

  if (!params.resetOnExit) {
    return null;
  }

  return async () => {
    try {
      if (params.tailscaleMode === "serve") {
        await disableTailscaleServe();
      } else {
        await disableTailscaleFunnel();
      }
    } catch (err) {
      params.logTailscale.warn(
        `${params.tailscaleMode} cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
}
