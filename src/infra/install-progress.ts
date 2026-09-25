import { randomUUID } from "node:crypto";
import type { PluginInstallActivity } from "../../packages/gateway-protocol/src/schema/plugins.js";

export type InstallActivityObserver = {
  activity?: (event: PluginInstallActivity) => void;
};

/** Only this operation's settlement completes its activity; later work cannot imply success. */
export async function withInstallActivity<T>(
  observer: InstallActivityObserver | undefined,
  stage: PluginInstallActivity["stage"],
  run: () => Promise<T>,
  succeeded: (result: T) => boolean = (result) =>
    !(result && typeof result === "object" && "ok" in result && result.ok === false),
): Promise<T> {
  if (!observer?.activity) {
    return await run();
  }
  const activityId = randomUUID();
  const emit = (status: PluginInstallActivity["status"]) => {
    // Activity is presentation only: a disconnected observer cannot change an install's outcome.
    try {
      observer.activity?.({ activityId, stage, status });
    } catch {
      /* observer retired */
    }
  };
  emit("started");
  try {
    const result = await run();
    emit(succeeded(result) ? "completed" : "failed");
    return result;
  } catch (error) {
    emit("failed");
    throw error;
  }
}
