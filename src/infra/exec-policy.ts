import type { ExecAsk, ExecMode, ExecSecurity } from "./exec-approvals.js";
import { resolveExecPolicyForMode } from "./exec-approvals.js";

export type ExecPolicyLayer = {
  mode?: ExecMode;
  security?: ExecSecurity;
  ask?: ExecAsk;
};

export type ApplyExecPolicyLayerOptions = {
  /**
   * Legacy security/ask config overrides predate mode. When such an override is
   * used as a config layer, clear any inherited mode so the effective mode is
   * re-derived from the legacy policy fields instead of the broader mode layer.
   */
  clearModeOnLegacyPolicy?: boolean;
};

export function applyExecPolicyLayer<TBase extends ExecPolicyLayer>(
  base: TBase,
  layer?: ExecPolicyLayer,
  options?: ApplyExecPolicyLayerOptions,
): TBase & ExecPolicyLayer {
  if (!layer) {
    return base;
  }
  if (layer.mode) {
    return {
      ...base,
      mode: layer.mode,
      ...resolveExecPolicyForMode(layer.mode),
    } as TBase & ExecPolicyLayer;
  }
  if (layer.security !== undefined || layer.ask !== undefined) {
    const nextBase = { ...base } as TBase & ExecPolicyLayer;
    if (options?.clearModeOnLegacyPolicy === true) {
      delete nextBase.mode;
    }
    return {
      ...nextBase,
      security: layer.security ?? base.security,
      ask: layer.ask ?? base.ask,
    } as TBase & ExecPolicyLayer;
  }
  return base;
}
