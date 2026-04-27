import { displayPath } from "../utils.js";
import { createConfigIO } from "./io.js";
export function formatConfigPath(path = createConfigIO().configPath) {
    return displayPath(path);
}
export function logConfigUpdated(runtime, opts = {}) {
    const path = formatConfigPath(opts.path ?? createConfigIO().configPath);
    const suffix = opts.suffix ? ` ${opts.suffix}` : "";
    runtime.log(`Updated ${path}${suffix}`);
}
