import {
  cloneEnvWithPlatformSemantics,
  createConfigRuntimeEnv,
} from "../../config/config-env-vars.js";
import {
  ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV,
  formatFutureConfigActionBlock,
  resolveFutureConfigActionBlock,
} from "../../config/future-version-guard.js";
// Gateway-specific future-config actions shared by pre-bootstrap and runtime startup.
import type { ConfigFileSnapshot, OpenClawConfig } from "../../config/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { GatewayRunOpts } from "./run-options.js";

export type GatewayRunPreBootstrapOptions = Pick<GatewayRunOpts, "force" | "reset">;

export function enforceGatewayRunFutureConfigGuard(params: {
  opts: GatewayRunPreBootstrapOptions;
  snapshot?: ConfigFileSnapshot | null;
  config?: Pick<OpenClawConfig, "env" | "meta"> | null;
  runtime: RuntimeEnv;
}): boolean {
  const processServiceMode = Boolean(process.env.OPENCLAW_SERVICE_MARKER?.trim());
  const candidateConfig =
    params.config ??
    (params.snapshot?.valid ? (params.snapshot.sourceConfig ?? params.snapshot.config) : undefined);
  const candidateServiceMode =
    !params.opts.reset &&
    Boolean(
      candidateConfig
        ? createConfigRuntimeEnv(candidateConfig, process.env).OPENCLAW_SERVICE_MARKER?.trim()
        : undefined,
    );
  const serviceMode = processServiceMode || candidateServiceMode;
  // Reset precedes service startup, port cleanup, and ordinary state preparation.
  const futureAction = params.opts.reset
    ? { action: "reset the dev gateway state", exitCode: 1 }
    : serviceMode
      ? { action: "start the gateway service", exitCode: 78 }
      : params.opts.force
        ? { action: "force-kill gateway port listeners", exitCode: 1 }
        : { action: "run gateway state preparation", exitCode: 1 };
  const guardEnv = serviceMode ? cloneEnvWithPlatformSemantics(process.env) : process.env;
  if (serviceMode) {
    delete guardEnv[ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV];
  }
  const block = resolveFutureConfigActionBlock({
    action: futureAction.action,
    snapshot: params.snapshot,
    config: params.config,
    env: guardEnv,
  });
  if (!block) {
    return true;
  }
  if (serviceMode) {
    delete process.env[ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV];
  }
  params.runtime.error(formatFutureConfigActionBlock(block));
  params.runtime.exit(futureAction.exitCode);
  return false;
}
