import { vi } from "vitest";
import { getDetachedTaskLifecycleRuntime } from "../../tasks/detached-task-runtime.js";
import { setDetachedTaskLifecycleRuntime } from "../../tasks/task-runtime.test-helpers.js";

export function spyDetachedCreateRunningTaskRun() {
  const defaultRuntime = getDetachedTaskLifecycleRuntime();
  const createRunningTaskRunSpy = vi.fn(
    (...args: Parameters<typeof defaultRuntime.createRunningTaskRun>) =>
      defaultRuntime.createRunningTaskRun(...args),
  );
  setDetachedTaskLifecycleRuntime({
    ...defaultRuntime,
    createRunningTaskRun: createRunningTaskRunSpy,
  });
  return createRunningTaskRunSpy;
}
