import { registerStatefulBindingTargetDriver } from "./stateful-target-drivers.js";

type AcpStatefulTargetDriverModule = typeof import("./acp-stateful-target-driver.js");

let builtinsRegisteredPromise: Promise<void> | null = null;
let acpDriverModulePromise: Promise<AcpStatefulTargetDriverModule> | undefined;

function loadAcpStatefulTargetDriverModule(): Promise<AcpStatefulTargetDriverModule> {
  acpDriverModulePromise ??= import("./acp-stateful-target-driver.js");
  return acpDriverModulePromise;
}

/** Returns whether a stateful target driver id is provided by core built-ins. */
export function isStatefulTargetBuiltinDriverId(id: string): boolean {
  return id.trim() === "acp";
}

/** Lazily registers built-in stateful target drivers exactly once. */
export async function ensureStatefulTargetBuiltinsRegistered(): Promise<void> {
  if (builtinsRegisteredPromise) {
    await builtinsRegisteredPromise;
    return;
  }
  builtinsRegisteredPromise = (async () => {
    const { acpStatefulBindingTargetDriver } = await loadAcpStatefulTargetDriverModule();
    registerStatefulBindingTargetDriver(acpStatefulBindingTargetDriver);
  })();
  try {
    await builtinsRegisteredPromise;
  } catch (error) {
    // A failed dynamic import must not permanently poison future registration attempts.
    builtinsRegisteredPromise = null;
    throw error;
  }
}
