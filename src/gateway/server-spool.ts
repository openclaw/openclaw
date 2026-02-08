/**
 * Gateway spool service integration.
 *
 * Similar to server-cron.ts, this module initializes the spool watcher
 * as a gateway sidecar service.
 */

import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SpoolDispatchResult } from "../spool/types.js";
import { getChildLogger } from "../logging.js";
import { resolveSpoolEventsDir } from "../spool/paths.js";
import { createSpoolWatcher, type SpoolWatcher } from "../spool/watcher.js";

export type GatewaySpoolState = {
  watcher: SpoolWatcher;
  eventsDir: string;
  spoolEnabled: boolean;
};

export function buildGatewaySpoolService(params: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
}): GatewaySpoolState {
  const spoolLogger = getChildLogger({ module: "spool" });
  const eventsDir = resolveSpoolEventsDir();
  const spoolEnabled =
    process.env.OPENCLAW_SKIP_SPOOL !== "1" && params.cfg.spool?.enabled !== false;

  const watcher = createSpoolWatcher({
    deps: params.deps,
    log: {
      info: (msg) => spoolLogger.info(msg),
      warn: (msg) => spoolLogger.warn(msg),
      error: (msg) => spoolLogger.error(msg),
    },
    onEvent: (result: SpoolDispatchResult) => {
      params.broadcast("spool", result, { dropIfSlow: true });
    },
  });

  return {
    watcher,
    eventsDir,
    spoolEnabled,
  };
}

export async function startGatewaySpoolWatcher(state: GatewaySpoolState): Promise<void> {
  if (!state.spoolEnabled) {
    return;
  }
  await state.watcher.start();
}

export async function stopGatewaySpoolWatcher(state: GatewaySpoolState): Promise<void> {
  // Always stop the watcher directly, even if startup was in flight
  // The watcher's stop() is safe to call regardless of running state
  await state.watcher.stop();
}
