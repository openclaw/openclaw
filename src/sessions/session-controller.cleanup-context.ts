import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type ControllerContextExit = <T>(run: () => T) => T;
const cleanupContext = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionControllerCleanupContext"),
  (): { exit?: ControllerContextExit } => ({}),
);

/** The controller's one context owner publishes only its exit capability to schedulers. */
export function bindSessionControllerCleanupContext(context: { exit<T>(run: () => T): T }): void {
  cleanupContext.exit = (run) => context.exit(run);
}

/** Preserve request context while leaving turn custody for independently owned work. */
export function runWithSessionControllerCleanup<T>(run: () => T): T {
  // Before the context owner loads, no turn can have installed inherited custody.
  return cleanupContext.exit ? cleanupContext.exit(run) : run();
}
