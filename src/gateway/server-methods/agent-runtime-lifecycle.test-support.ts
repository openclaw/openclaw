import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { flushPendingSessionsChangedEvents } from "./session-change-event.js";

export async function drainAgentHandlerTestRuntime(): Promise<void> {
  // Drain deferred broadcasts before retiring the test-owned row and runtime state.
  await flushPendingSessionsChangedEvents();
  // Direct fixtures have no Gateway close and may leave synthetic runs pending.
  // Retire their close-owned admission reservations before the next test.
  await drainGlobalSingletonLifecycleState("close");
}
