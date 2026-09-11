import { UpdatePreMutationError } from "./shared.js";
import {
  maybeStopManagedServiceBeforeMutableUpdate,
  type PreManagedServiceStop,
} from "./update-command-service.js";

/** Current-core maintenance keeps one stopped interval from its first write through activation. */
export async function parkCurrentCoreUpdate(
  params: Omit<
    Parameters<typeof maybeStopManagedServiceBeforeMutableUpdate>[0],
    "shouldRestart" | "phase" | "expectedService"
  > & { before?: PreManagedServiceStop },
  assertCurrent: () => void,
): Promise<PreManagedServiceStop> {
  assertCurrent();
  const { before, ...options } = params;
  if (!before) {
    throw new Error("Plugin maintenance lost its update service owner.");
  }
  if (before.stopped) {
    return before;
  }
  await before.windowsTaskAutoStartRecovery?.complete(true);
  assertCurrent();
  const stopped = await maybeStopManagedServiceBeforeMutableUpdate({
    ...options,
    shouldRestart: true,
    phase: "prepare",
    expectedService: before,
  });
  assertCurrent();
  if (stopped.blockMessage || (stopped.running && !stopped.stopped)) {
    throw new UpdatePreMutationError(
      "managed-service-preflight",
      stopped.blockMessage ?? "Gateway writers could not be parked for plugin maintenance.",
    );
  }
  return stopped;
}
