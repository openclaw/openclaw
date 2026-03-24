import { MemoryWriteParams } from "../types.js";

/**
 * Enforces project namespace integrity for memory writes.
 * Prevents agents from writing to unauthorized project scopes (#53930).
 */
export function validateMemoryNamespace(params: MemoryWriteParams, authorizedNamespace: string) {
    if (params.namespace && params.namespace !== authorizedNamespace) {
        throw new Error(`Namespace mismatch: Agent is authorized for "${authorizedNamespace}" but attempted to write to "${params.namespace}".`);
    }
    return true;
}
