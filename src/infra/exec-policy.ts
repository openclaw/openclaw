import type { ExecAsk, ExecMode, ExecSecurity } from "./exec-approvals.js";
import { resolveExecPolicyForMode } from "./exec-approvals.js";

export type ExecPolicyLayer = {
  mode?: ExecMode;
  security?: ExecSecurity;
  ask?: ExecAsk;
};

export function applyExecPolicyLayer<TBase extends ExecPolicyLayer>(
  base: TBase,
  layer?: ExecPolicyLayer,
): TBase & ExecPolicyLayer {
  if (!layer) {
    return base;
  }
  if (layer.mode) {
    return {
      ...base,
      mode: layer.mode,
      ...resolveExecPolicyForMode(layer.mode),
    };
  }
  if (layer.security !== undefined || layer.ask !== undefined) {
    return {
      ...base,
      security: layer.security ?? base.security,
      ask: layer.ask ?? base.ask,
    };
  }
  return base;
}
