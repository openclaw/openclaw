import { createNonExitingRuntime } from "../../runtime.js";
import { normalizeStringEntries } from "../../shared/string-normalization.js";
export function resolveRuntime(opts) {
    return opts.runtime ?? createNonExitingRuntime();
}
export function normalizeAllowList(list) {
    return normalizeStringEntries(list);
}
