import { ensureStatefulTargetBuiltinsRegistered, isStatefulTargetBuiltinDriverId, } from "./stateful-target-builtins.js";
import { getStatefulBindingTargetDriver, resolveStatefulBindingTargetBySessionKey, } from "./stateful-target-drivers.js";
export async function ensureConfiguredBindingTargetReady(params) {
    if (!params.bindingResolution) {
        return { ok: true };
    }
    const driverId = params.bindingResolution.statefulTarget.driverId;
    let driver = getStatefulBindingTargetDriver(driverId);
    if (!driver && isStatefulTargetBuiltinDriverId(driverId)) {
        await ensureStatefulTargetBuiltinsRegistered();
        driver = getStatefulBindingTargetDriver(driverId);
    }
    if (!driver) {
        return {
            ok: false,
            error: `Configured binding target driver unavailable: ${driverId}`,
        };
    }
    return await driver.ensureReady({
        cfg: params.cfg,
        bindingResolution: params.bindingResolution,
    });
}
export async function resetConfiguredBindingTargetInPlace(params) {
    let resolved = resolveStatefulBindingTargetBySessionKey({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
    });
    if (!resolved) {
        await ensureStatefulTargetBuiltinsRegistered();
        resolved = resolveStatefulBindingTargetBySessionKey({
            cfg: params.cfg,
            sessionKey: params.sessionKey,
        });
    }
    if (!resolved?.driver.resetInPlace) {
        return {
            ok: false,
            skipped: true,
        };
    }
    return await resolved.driver.resetInPlace({
        ...params,
        bindingTarget: resolved.bindingTarget,
    });
}
export async function ensureConfiguredBindingTargetSession(params) {
    const driverId = params.bindingResolution.statefulTarget.driverId;
    let driver = getStatefulBindingTargetDriver(driverId);
    if (!driver && isStatefulTargetBuiltinDriverId(driverId)) {
        await ensureStatefulTargetBuiltinsRegistered();
        driver = getStatefulBindingTargetDriver(driverId);
    }
    if (!driver) {
        return {
            ok: false,
            sessionKey: params.bindingResolution.statefulTarget.sessionKey,
            error: `Configured binding target driver unavailable: ${driverId}`,
        };
    }
    return await driver.ensureSession({
        cfg: params.cfg,
        bindingResolution: params.bindingResolution,
    });
}
