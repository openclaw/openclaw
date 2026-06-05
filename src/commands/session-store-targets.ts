/**
 * Session store target resolution wrapper for CLI commands.
 *
 * The config helper throws on invalid agent/store combinations; this module
 * converts those errors into command output and exit codes.
 */
import {
  resolveAgentSessionStoreTargetsSync,
  resolveSessionStoreTargets,
  type SessionStoreSelectionOptions,
  type SessionStoreTarget,
} from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { RuntimeEnv } from "../runtime.js";
export { resolveSessionStoreTargets, type SessionStoreSelectionOptions, type SessionStoreTarget };

/** Resolves session store targets for CLI commands, including existing on-disk agent stores. */
export function resolveCommandSessionStoreTargets(
  cfg: OpenClawConfig,
  opts: SessionStoreSelectionOptions,
): SessionStoreTarget[] {
  if (opts.agent?.trim() && !opts.allAgents && !opts.store) {
    const discoveredTargets = resolveAgentSessionStoreTargetsSync(cfg, opts.agent);
    if (discoveredTargets.length > 0) {
      return discoveredTargets;
    }
  }
  return resolveSessionStoreTargets(cfg, opts);
}

/** Resolves session store targets or exits the current command on validation errors. */
export function resolveSessionStoreTargetsOrExit(params: {
  cfg: OpenClawConfig;
  opts: SessionStoreSelectionOptions;
  runtime: RuntimeEnv;
}): SessionStoreTarget[] | null {
  try {
    return resolveCommandSessionStoreTargets(params.cfg, params.opts);
  } catch (error) {
    params.runtime.error(formatErrorMessage(error));
    params.runtime.exit(1);
    return null;
  }
}
