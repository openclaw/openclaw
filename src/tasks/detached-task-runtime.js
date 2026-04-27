import { createSubsystemLogger } from "../logging/subsystem.js";
import { clearDetachedTaskLifecycleRuntimeRegistration, getDetachedTaskLifecycleRuntimeRegistration as getDetachedTaskLifecycleRuntimeRegistrationState, getRegisteredDetachedTaskLifecycleRuntime, registerDetachedTaskLifecycleRuntime, } from "./detached-task-runtime-state.js";
import { cancelTaskById as cancelDetachedTaskRunByIdInCore } from "./runtime-internal.js";
import { completeTaskRunByRunId as completeTaskRunByRunIdFromExecutor, createQueuedTaskRun as createQueuedTaskRunFromExecutor, createRunningTaskRun as createRunningTaskRunFromExecutor, failTaskRunByRunId as failTaskRunByRunIdFromExecutor, recordTaskRunProgressByRunId as recordTaskRunProgressByRunIdFromExecutor, setDetachedTaskDeliveryStatusByRunId as setDetachedTaskDeliveryStatusByRunIdFromExecutor, startTaskRunByRunId as startTaskRunByRunIdFromExecutor, } from "./task-executor.js";
const log = createSubsystemLogger("tasks/detached-runtime");
const DETACHED_TASK_RECOVERY_WARN_MS = 5_000;
const DEFAULT_DETACHED_TASK_LIFECYCLE_RUNTIME = {
    createQueuedTaskRun: createQueuedTaskRunFromExecutor,
    createRunningTaskRun: createRunningTaskRunFromExecutor,
    startTaskRunByRunId: startTaskRunByRunIdFromExecutor,
    recordTaskRunProgressByRunId: recordTaskRunProgressByRunIdFromExecutor,
    completeTaskRunByRunId: completeTaskRunByRunIdFromExecutor,
    failTaskRunByRunId: failTaskRunByRunIdFromExecutor,
    setDetachedTaskDeliveryStatusByRunId: setDetachedTaskDeliveryStatusByRunIdFromExecutor,
    cancelDetachedTaskRunById: cancelDetachedTaskRunByIdInCore,
};
export function getDetachedTaskLifecycleRuntime() {
    return getRegisteredDetachedTaskLifecycleRuntime() ?? DEFAULT_DETACHED_TASK_LIFECYCLE_RUNTIME;
}
export function getDetachedTaskLifecycleRuntimeRegistration() {
    return getDetachedTaskLifecycleRuntimeRegistrationState();
}
export function registerDetachedTaskRuntime(pluginId, runtime) {
    registerDetachedTaskLifecycleRuntime(pluginId, runtime);
}
export function setDetachedTaskLifecycleRuntime(runtime) {
    registerDetachedTaskRuntime("__test__", runtime);
}
export function resetDetachedTaskLifecycleRuntimeForTests() {
    clearDetachedTaskLifecycleRuntimeRegistration();
}
export function createQueuedTaskRun(...args) {
    return getDetachedTaskLifecycleRuntime().createQueuedTaskRun(...args);
}
export function createRunningTaskRun(...args) {
    return getDetachedTaskLifecycleRuntime().createRunningTaskRun(...args);
}
export function startTaskRunByRunId(...args) {
    return getDetachedTaskLifecycleRuntime().startTaskRunByRunId(...args);
}
export function recordTaskRunProgressByRunId(...args) {
    return getDetachedTaskLifecycleRuntime().recordTaskRunProgressByRunId(...args);
}
export function completeTaskRunByRunId(...args) {
    return getDetachedTaskLifecycleRuntime().completeTaskRunByRunId(...args);
}
export function failTaskRunByRunId(...args) {
    return getDetachedTaskLifecycleRuntime().failTaskRunByRunId(...args);
}
export function setDetachedTaskDeliveryStatusByRunId(...args) {
    return getDetachedTaskLifecycleRuntime().setDetachedTaskDeliveryStatusByRunId(...args);
}
export function cancelDetachedTaskRunById(...args) {
    return getDetachedTaskLifecycleRuntime().cancelDetachedTaskRunById(...args);
}
export async function tryRecoverTaskBeforeMarkLost(params) {
    const hook = getDetachedTaskLifecycleRuntime().tryRecoverTaskBeforeMarkLost;
    if (!hook) {
        return { recovered: false };
    }
    const startedAt = Date.now();
    try {
        const result = await hook(params);
        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs >= DETACHED_TASK_RECOVERY_WARN_MS) {
            log.warn("Detached task recovery hook was slow", {
                taskId: params.taskId,
                runtime: params.runtime,
                elapsedMs,
            });
        }
        if (result && typeof result.recovered === "boolean") {
            return result;
        }
        log.warn("Detached task recovery hook returned invalid result, proceeding with markTaskLost", {
            taskId: params.taskId,
            runtime: params.runtime,
            result,
        });
        return { recovered: false };
    }
    catch (err) {
        log.warn("Detached task recovery hook threw, proceeding with markTaskLost", {
            taskId: params.taskId,
            runtime: params.runtime,
            elapsedMs: Date.now() - startedAt,
            error: err,
        });
        return { recovered: false };
    }
}
