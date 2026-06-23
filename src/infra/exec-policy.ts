import type { ExecAsk, ExecMode, ExecSecurity } from "./exec-approvals.js";
import { resolveExecPolicyForMode } from "./exec-approvals.js";

export type ExecPolicyLayer = {
  mode?: ExecMode;
  security?: ExecSecurity;
  ask?: ExecAsk;
};

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Preserve each caller's required policy fields.
export function applyExecPolicyLayer<TBase extends ExecPolicyLayer>(
  base: TBase,
  layer?: ExecPolicyLayer,
): TBase & ExecPolicyLayer {
  if (!layer) {
    return base;
  }
  if (layer.mode) {
    return {
      mode: layer.mode,
      ...resolveExecPolicyForMode(layer.mode),
    } as TBase & ExecPolicyLayer;
  }
  if (layer.security !== undefined || layer.ask !== undefined) {
    return {
      security: layer.security ?? base.security,
      ask: layer.ask ?? base.ask,
    } as TBase & ExecPolicyLayer;
  }
  return base;
}
