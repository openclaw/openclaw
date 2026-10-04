import { registerStatefulBindingTargetDriver } from "./stateful-target-drivers.js";

export function isStatefulTargetBuiltinDriverId(id: string): boolean {
  return id.trim() === "acp";
}

export async function ensureStatefulTargetBuiltinsRegistered(): Promise<void> {
  const { acpStatefulBindingTargetDriver } = await import("./acp-stateful-target-driver.js");
  registerStatefulBindingTargetDriver(acpStatefulBindingTargetDriver);
}
