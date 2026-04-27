let detachedTaskLifecycleRuntimeRegistration;
export function registerDetachedTaskLifecycleRuntime(pluginId, runtime) {
    detachedTaskLifecycleRuntimeRegistration = {
        pluginId,
        runtime,
    };
}
export function getDetachedTaskLifecycleRuntimeRegistration() {
    if (!detachedTaskLifecycleRuntimeRegistration) {
        return undefined;
    }
    return {
        pluginId: detachedTaskLifecycleRuntimeRegistration.pluginId,
        runtime: detachedTaskLifecycleRuntimeRegistration.runtime,
    };
}
export function getRegisteredDetachedTaskLifecycleRuntime() {
    return detachedTaskLifecycleRuntimeRegistration?.runtime;
}
export function restoreDetachedTaskLifecycleRuntimeRegistration(registration) {
    detachedTaskLifecycleRuntimeRegistration = registration
        ? {
            pluginId: registration.pluginId,
            runtime: registration.runtime,
        }
        : undefined;
}
export function clearDetachedTaskLifecycleRuntimeRegistration() {
    detachedTaskLifecycleRuntimeRegistration = undefined;
}
export const _resetDetachedTaskLifecycleRuntimeRegistration = clearDetachedTaskLifecycleRuntimeRegistration;
