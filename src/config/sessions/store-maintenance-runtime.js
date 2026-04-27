import { loadConfig } from "../config.js";
import { resolveMaintenanceConfigFromInput, } from "./store-maintenance.js";
export function resolveMaintenanceConfig() {
    let maintenance;
    try {
        maintenance = loadConfig().session?.maintenance;
    }
    catch {
        // Config may not be available in narrow test/runtime helpers.
    }
    return resolveMaintenanceConfigFromInput(maintenance);
}
