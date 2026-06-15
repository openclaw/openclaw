import {
  formatFutureConfigActionBlock,
  resolveFutureConfigActionBlock,
} from "../../config/future-version-guard.js";
// Gateway-specific future-config actions shared by pre-bootstrap and runtime startup.
import type { ConfigFileSnapshot, OpenClawConfig } from "../../config/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { GatewayRunOpts } from "./run-options.js";

export type GatewayRunPreBootstrapOptions = Pick<GatewayRunOpts, "force" | "reset">;

type GatewayRunFutureConfigGuardParams = {
  opts: GatewayRunPreBootstrapOptions;
  snapshot?: ConfigFileSnapshot | null;
  config?: Pick<OpenClawConfig, "meta"> | null;
};

function resolveGatewayRunFutureConfigBlock(params: GatewayRunFutureConfigGuardParams) {
  // Reset runs before service/force startup, while ordinary startup now runs state migrations.
  const futureAction = params.opts.reset
    ? { action: "reset the dev gateway state", exitCode: 1 }
    : process.env.OPENCLAW_SERVICE_MARKER?.trim()
      ? { action: "start the gateway service", exitCode: 78 }
      : params.opts.force
        ? { action: "force-kill gateway port listeners", exitCode: 1 }
        : { action: "run automatic gateway startup migrations", exitCode: 1 };
  const block = resolveFutureConfigActionBlock({
    action: futureAction.action,
    snapshot: params.snapshot,
    config: params.config,
  });
  return block ? { block, exitCode: futureAction.exitCode } : null;
}

export function isGatewayRunFutureConfigAllowed(
  params: GatewayRunFutureConfigGuardParams,
): boolean {
  return resolveGatewayRunFutureConfigBlock(params) === null;
}

export function enforceGatewayRunFutureConfigGuard(
  params: GatewayRunFutureConfigGuardParams & { runtime: RuntimeEnv },
): boolean {
  const resolved = resolveGatewayRunFutureConfigBlock(params);
  if (!resolved) {
    return true;
  }
  params.runtime.error(formatFutureConfigActionBlock(resolved.block));
  params.runtime.exit(resolved.exitCode);
  return false;
}
