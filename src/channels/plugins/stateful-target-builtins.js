import { registerStatefulBindingTargetDriver, unregisterStatefulBindingTargetDriver, } from "./stateful-target-drivers.js";
let builtinsRegisteredPromise = null;
let acpDriverModulePromise;
function loadAcpStatefulTargetDriverModule() {
    acpDriverModulePromise ??= import("./acp-stateful-target-driver.js");
    return acpDriverModulePromise;
}
export function isStatefulTargetBuiltinDriverId(id) {
    return id.trim() === "acp";
}
export async function ensureStatefulTargetBuiltinsRegistered() {
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
    }
    catch (error) {
        builtinsRegisteredPromise = null;
        throw error;
    }
}
export async function resetStatefulTargetBuiltinsForTesting() {
    builtinsRegisteredPromise = null;
    const { acpStatefulBindingTargetDriver } = await loadAcpStatefulTargetDriverModule();
    unregisterStatefulBindingTargetDriver(acpStatefulBindingTargetDriver.id);
}
