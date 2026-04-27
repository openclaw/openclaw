import { createSubsystemLogger } from "../../logging/subsystem.js";
const log = createSubsystemLogger("process/supervisor");
export function warnProcessSupervisorSpawnFailure(message) {
    log.warn(message);
}
