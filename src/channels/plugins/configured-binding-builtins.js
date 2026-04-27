import { acpConfiguredBindingConsumer } from "./acp-configured-binding-consumer.js";
import { registerConfiguredBindingConsumer, unregisterConfiguredBindingConsumer, } from "./configured-binding-consumers.js";
export function ensureConfiguredBindingBuiltinsRegistered() {
    registerConfiguredBindingConsumer(acpConfiguredBindingConsumer);
}
export function resetConfiguredBindingBuiltinsForTesting() {
    unregisterConfiguredBindingConsumer(acpConfiguredBindingConsumer.id);
}
