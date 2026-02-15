import type { DaemonLifecycleOptions } from "./types.js";
import { resolveGatewayService } from "../../daemon/service.js";
import {
  runServiceRestart,
  runServiceStart,
  runServiceStop,
  runServiceUninstall,
} from "./lifecycle-core.js";
import { renderGatewayServiceStartHints } from "./shared.js";

export async function runDaemonUninstall(opts: DaemonLifecycleOptions = {}) {
  return await runServiceUninstall({
    serviceNoun: "Gateway",
    service: resolveGatewayService(),
    opts,
    stopBeforeUninstall: true,
    assertNotLoadedAfterUninstall: true,
  });
}

export async function runDaemonStart(opts: DaemonLifecycleOptions = {}) {
  return await runServiceStart({
    serviceNoun: "Gateway",
    service: resolveGatewayService(),
    renderStartHints: renderGatewayServiceStartHints,
    opts,
  });
}

export async function runDaemonStop(opts: DaemonLifecycleOptions = {}) {
  return await runServiceStop({
    serviceNoun: "Gateway",
    service: resolveGatewayService(),
    opts,
  });
}

/**
 * Restart the gateway service service.
 * @returns `true` if restart succeeded, `false` if the service was not loaded.
 * Throws/exits on check or restart failures.
 */
export async function runDaemonRestart(opts: DaemonLifecycleOptions = {}): Promise<boolean> {
  return await runServiceRestart({
    serviceNoun: "Gateway",
    service: resolveGatewayService(),
    renderStartHints: renderGatewayServiceStartHints,
    opts,
  });
}

/**
 * Preload daemon-cli module and its dependencies.
 * This ensures all required modules are loaded into memory before any update process
 * that might delete the on-disk files.
 */
export async function preloadDaemonCli(): Promise<void> {
  // Import all daemon-cli dependencies to ensure they're cached in memory
  await import("./lifecycle-core.js");
  await import("./shared.js");
  await import("../../daemon/service.js");
}
