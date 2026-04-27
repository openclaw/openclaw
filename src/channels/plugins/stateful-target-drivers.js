const registeredStatefulBindingTargetDrivers = new Map();
function listStatefulBindingTargetDrivers() {
    return [...registeredStatefulBindingTargetDrivers.values()];
}
export function registerStatefulBindingTargetDriver(driver) {
    const id = driver.id.trim();
    if (!id) {
        throw new Error("Stateful binding target driver id is required");
    }
    const normalized = { ...driver, id };
    const existing = registeredStatefulBindingTargetDrivers.get(id);
    if (existing) {
        return;
    }
    registeredStatefulBindingTargetDrivers.set(id, normalized);
}
export function unregisterStatefulBindingTargetDriver(id) {
    registeredStatefulBindingTargetDrivers.delete(id.trim());
}
export function getStatefulBindingTargetDriver(id) {
    const normalizedId = id.trim();
    if (!normalizedId) {
        return null;
    }
    return registeredStatefulBindingTargetDrivers.get(normalizedId) ?? null;
}
export function resolveStatefulBindingTargetBySessionKey(params) {
    const sessionKey = params.sessionKey.trim();
    if (!sessionKey) {
        return null;
    }
    for (const driver of listStatefulBindingTargetDrivers()) {
        const bindingTarget = driver.resolveTargetBySessionKey?.({
            cfg: params.cfg,
            sessionKey,
        });
        if (bindingTarget) {
            return {
                driver,
                bindingTarget,
            };
        }
    }
    return null;
}
