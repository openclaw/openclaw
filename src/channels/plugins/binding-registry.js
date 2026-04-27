import { ensureConfiguredBindingBuiltinsRegistered } from "./configured-binding-builtins.js";
import { primeConfiguredBindingRegistry as primeConfiguredBindingRegistryRaw, resolveConfiguredBinding as resolveConfiguredBindingRaw, resolveConfiguredBindingRecord as resolveConfiguredBindingRecordRaw, resolveConfiguredBindingRecordBySessionKey as resolveConfiguredBindingRecordBySessionKeyRaw, resolveConfiguredBindingRecordForConversation as resolveConfiguredBindingRecordForConversationRaw, } from "./configured-binding-registry.js";
// Thin public wrapper around the configured-binding registry. Runtime plugin
// conversation bindings use a separate approval-driven path in src/plugins/.
export function primeConfiguredBindingRegistry(...args) {
    ensureConfiguredBindingBuiltinsRegistered();
    return primeConfiguredBindingRegistryRaw(...args);
}
export function resolveConfiguredBindingRecord(...args) {
    ensureConfiguredBindingBuiltinsRegistered();
    return resolveConfiguredBindingRecordRaw(...args);
}
export function resolveConfiguredBindingRecordForConversation(...args) {
    ensureConfiguredBindingBuiltinsRegistered();
    return resolveConfiguredBindingRecordForConversationRaw(...args);
}
export function resolveConfiguredBinding(...args) {
    ensureConfiguredBindingBuiltinsRegistered();
    return resolveConfiguredBindingRaw(...args);
}
export function resolveConfiguredBindingRecordBySessionKey(...args) {
    ensureConfiguredBindingBuiltinsRegistered();
    return resolveConfiguredBindingRecordBySessionKeyRaw(...args);
}
