import { createProcessSupervisor } from "./supervisor.js";
let singleton = null;
export function getProcessSupervisor() {
    if (singleton) {
        return singleton;
    }
    singleton = createProcessSupervisor();
    return singleton;
}
export { createProcessSupervisor } from "./supervisor.js";
