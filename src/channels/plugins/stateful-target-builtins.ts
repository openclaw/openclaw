import { acpStatefulBindingTargetDriver } from "./acp-stateful-target-driver.js";
import {
  registerStatefulBindingTargetDriver,
  unregisterStatefulBindingTargetDriver,
} from "./stateful-target-drivers.js";

export function ensureStatefulTargetBuiltinsRegistered(): void {
  registerStatefulBindingTargetDriver(acpStatefulBindingTargetDriver);
}

export function resetStatefulTargetBuiltinsForTesting(): void {
  unregisterStatefulBindingTargetDriver(acpStatefulBindingTargetDriver.id);
}
