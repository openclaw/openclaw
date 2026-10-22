import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isSecretRef } from "../config/types.secrets.js";
import { settlesWithin } from "../shared/settle-within.js";
import { isRecord } from "../utils.js";
import { reloadPlanNeedsRecovery } from "./config-reload-recovery.js";
import type { GatewayReloadPlan } from "./config-reload.js";
import { GatewayReloadRequiresRecoveryOwnerError } from "./server-reload-contracts.js";

function projectCanonicalSecretRefsOntoRuntime(
  sourceValue: unknown,
  runtimeValue: unknown,
): unknown {
  if (isSecretRef(sourceValue)) {
    return sourceValue;
  }
  if (Array.isArray(sourceValue)) {
    const runtimeArray = Array.isArray(runtimeValue) ? runtimeValue : [];
    return sourceValue.map((entry, index) =>
      projectCanonicalSecretRefsOntoRuntime(entry, runtimeArray[index]),
    );
  }
  if (isRecord(sourceValue)) {
    const runtimeRecord = isRecord(runtimeValue) ? runtimeValue : {};
    const projected: Record<string, unknown> = { ...runtimeRecord };
    for (const [key, entry] of Object.entries(sourceValue)) {
      projected[key] = projectCanonicalSecretRefsOntoRuntime(entry, runtimeRecord[key]);
    }
    return projected;
  }
  return runtimeValue === undefined ? sourceValue : runtimeValue;
}

export function restoreCanonicalSecretRefs(
  runtimeConfig: OpenClawConfig,
  sourceConfig: OpenClawConfig,
): OpenClawConfig {
  return projectCanonicalSecretRefsOntoRuntime(sourceConfig, runtimeConfig) as OpenClawConfig;
}

export function assertIrreversibleReloadPlanHasRecoveryOwner(
  plan: GatewayReloadPlan,
  restartRecoveryAvailable: boolean | undefined,
): void {
  if (restartRecoveryAvailable !== false) {
    return;
  }
  if (plan.restartGateway) {
    throw new GatewayReloadRequiresRecoveryOwnerError("gateway restart");
  }
  if (plan.pluginLifecycle && plan.reloadPlugins) {
    // Prepared replacement targets determine which config effects still need Gateway recovery.
    return;
  }
  // These plans retire a live service or plugin generation before replacement
  // can be proven. Context cache refresh also needs recovery because it can
  // reject after runtime publication; simple in-place updates stay atomic.
  if (reloadPlanNeedsRecovery(plan)) {
    throw new GatewayReloadRequiresRecoveryOwnerError("irreversible hot reload");
  }
}

export async function disposeMcpRuntimesWithTimeout(params: {
  dispose: () => Promise<void>;
  timeoutMs: number;
  onWarn: (message: string) => void;
  label: string;
}) {
  // MCP runtime disposal may need async provider cleanup. Bound it so config
  // reload can proceed and report the stale runtime risk.
  const disposePromise = Promise.resolve()
    .then(params.dispose)
    .catch((error: unknown) => {
      params.onWarn(`${params.label} failed: ${String(error)}`);
    });
  if (!(await settlesWithin(disposePromise, params.timeoutMs))) {
    params.onWarn(`${params.label} exceeded ${params.timeoutMs}ms; continuing`);
  }
}
