import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { registerStatefulBindingTargetDriver } from "./stateful-target-drivers.js";

const loadAcpStatefulTargetDriverModule = createLazyRuntimeModule(
  () => import("./acp-stateful-target-driver.js"),
);

export function isStatefulTargetBuiltinDriverId(id: string): boolean {
  return id.trim() === "acp";
}

export async function ensureStatefulTargetBuiltinsRegistered(): Promise<void> {
  try {
    const { acpStatefulBindingTargetDriver } = await loadAcpStatefulTargetDriverModule();
    registerStatefulBindingTargetDriver(acpStatefulBindingTargetDriver);
  } catch (error) {
    // A rejected lazy import is cached; clear it so a later setup or binding attempt can retry.
    loadAcpStatefulTargetDriverModule.clear();
    throw error;
  }
}
