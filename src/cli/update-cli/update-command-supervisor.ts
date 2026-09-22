import type { GatewayService } from "../../daemon/service.js";

export async function hasLoadedLaunchdKeepAliveSupervisor(params: {
  service: GatewayService;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  if (process.platform !== "darwin") {
    return false;
  }
  // OpenClaw's loaded LaunchAgent has canonical KeepAlive policy. Read this once before
  // polling so an unloaded agent can still reach the existing recovery path promptly.
  return await params.service.isLoaded({ env: params.env }).catch(() => false);
}
