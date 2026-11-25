import { createSubsystemLogger } from "../../logging/subsystem.js";

/** Runtime logging boundary for lazy supervisor paths and focused test mocks. */
const log = createSubsystemLogger("process/supervisor");

/** Report failures without importing the full logging subsystem in tests. */
export function warnProcessSupervisorFailure(message: string) {
  log.warn(message);
}
