import {
  resolveSessionDatabaseTargets,
  type SessionDatabaseSelectionOptions,
  type SessionDatabaseTarget,
} from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { RuntimeEnv } from "../runtime.js";
export {
  resolveSessionDatabaseTargets,
  type SessionDatabaseSelectionOptions,
  type SessionDatabaseTarget,
};

export function resolveSessionDatabaseTargetsOrExit(params: {
  cfg: OpenClawConfig;
  opts: SessionDatabaseSelectionOptions;
  runtime: RuntimeEnv;
}): SessionDatabaseTarget[] | null {
  try {
    return resolveSessionDatabaseTargets(params.cfg, params.opts);
  } catch (error) {
    params.runtime.error(formatErrorMessage(error));
    params.runtime.exit(1);
    return null;
  }
}
