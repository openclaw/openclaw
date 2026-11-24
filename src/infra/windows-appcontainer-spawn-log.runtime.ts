import { createSubsystemLogger } from "../logging/subsystem.js";

export function logAppContainerTokenProbeFailure(error: unknown): void {
  createSubsystemLogger("process").debug("AppContainer token probe failed; allowing spawn", {
    error: String(error),
  });
}
