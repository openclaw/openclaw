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
import { resolveSpoolEventsDir, resolveSpoolDeadLetterDir } from "../spool/paths.js";
import {
  createSpoolWatcher,
  type SpoolWatcher,
  type SpoolWatcherHandle,
} from "../spool/watcher.js";

export type GatewaySpoolState = {
  watcher: SpoolWatcher;
  handle: SpoolWatcherHandle | null;
  eventsDir: string;
  deadLetterDir: string;
  spoolEnabled: boolean;
};

export function buildGatewaySpoolService(params: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
}): GatewaySpoolState {
  const spoolLogger = getChildLogger({ module: "spool" });
  const eventsDir = resolveSpoolEventsDir();
  const deadLetterDir = resolveSpoolDeadLetterDir();
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
    handle: null,
    eventsDir,
    deadLetterDir,
    spoolEnabled,
  };
}

export async function startGatewaySpoolWatcher(
  state: GatewaySpoolState,
): Promise<SpoolWatcherHandle | null> {
  if (!state.spoolEnabled) {
    return null;
  }

  await state.watcher.start();
  state.handle = {
    watcher: state.watcher,
    stop: () => state.watcher.stop(),
  };

  return state.handle;
}

export async function stopGatewaySpoolWatcher(state: GatewaySpoolState): Promise<void> {
  // Always stop the watcher directly, even if handle is unset (startup in flight)
  // The watcher's stop() is safe to call regardless of running state
  await state.watcher.stop();
  state.handle = null;
}
