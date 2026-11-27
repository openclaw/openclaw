import type { ExecAsk, ExecMode, ExecSecurity } from "./exec-approvals-core.js";
import { resolveExecPolicyForMode } from "./exec-approvals-core.js";
import { maxAsk, minSecurity } from "./exec-approvals-policy.js";

type ExecPolicyLayer = {
  mode?: ExecMode;
  security?: ExecSecurity;
  ask?: ExecAsk;
};

type RequiredExecPolicy = Required<Pick<ExecPolicyLayer, "security" | "ask">>;

export function applyExecPolicyLayer<TBase extends ExecPolicyLayer & RequiredExecPolicy>(
  base: TBase,
  layer?: ExecPolicyLayer,
): Omit<TBase, keyof ExecPolicyLayer> & ExecPolicyLayer & RequiredExecPolicy;
export function applyExecPolicyLayer<TBase extends ExecPolicyLayer>(
  base: TBase,
  layer?: ExecPolicyLayer,
): Omit<TBase, keyof ExecPolicyLayer> & ExecPolicyLayer;
export function applyExecPolicyLayer(
  base: ExecPolicyLayer,
  layer?: ExecPolicyLayer,
): ExecPolicyLayer {
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
    const { mode: _mode, ...baseWithoutMode } = base;
    return {
      ...baseWithoutMode,
      security: layer.security ?? base.security,
      ask: layer.ask ?? base.ask,
    };
  }
  return base;
}

export type ExecPolicyCeiling = Readonly<{
  security: ExecSecurity;
  ask: ExecAsk;
  denyMisses?: true;
}>;

export function deniesExecAllowlistMisses(policy: ExecPolicyCeiling | undefined): boolean {
  return policy?.denyMisses === true || (policy?.security === "allowlist" && policy.ask === "off");
}

/** A denied allowlist miss cannot become an approvable miss; mandatory approval still wins. */
export function intersectExecPolicyCeilings(
  retained: ExecPolicyCeiling | undefined,
  current: ExecPolicyCeiling | undefined,
): ExecPolicyCeiling | undefined {
  if (!retained || !current) {
    return retained ?? current;
  }
  const deniesMisses = (policy: ExecPolicyCeiling) =>
    policy.security !== "full" && policy.ask === "off";
  return {
    security: minSecurity(retained.security, current.security),
    ...(retained.denyMisses ||
    current.denyMisses ||
    ((retained.ask === "always" || current.ask === "always") &&
      (deniesExecAllowlistMisses(retained) || deniesExecAllowlistMisses(current)))
      ? { denyMisses: true }
      : {}),
    ask:
      retained.ask !== "always" &&
      current.ask !== "always" &&
      (deniesMisses(retained) || deniesMisses(current))
        ? "off"
        : maxAsk(retained.ask, current.ask),
  };
}
