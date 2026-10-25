import { AsyncContext } from "../shared/async-context.js";
import { bindSessionControllerCleanupContext } from "./session-controller.cleanup-context.js";
import type { OwnerContext } from "./session-controller.contracts.js";

// One context owner publishes its exit capability to the scheduler-facing leaf.
// Context carries exact controller objects; it grants no independent admission or authority.
export const ownerContext = new AsyncContext<OwnerContext>(
  Symbol.for("openclaw.sessionControllerOwnerContext"),
);
bindSessionControllerCleanupContext(ownerContext);

/** Work that outlives the current turn (required cleanup, scheduled or fire-and-forget work)
 * leaves its controller context, so it acquires its own owner instead of inheriting the
 * retired turn. Nested work that belongs to the turn must not use this. */
export { runWithSessionControllerCleanup } from "./session-controller.cleanup-context.js";
