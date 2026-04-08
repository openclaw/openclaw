import { acpConfiguredBindingConsumer } from "./acp-configured-binding-consumer.js";
import {
  registerConfiguredBindingConsumer,
  unregisterConfiguredBindingConsumer,
} from "./configured-binding-consumers.js";

export function ensureConfiguredBindingBuiltinsRegistered(): void {
  registerConfiguredBindingConsumer(acpConfiguredBindingConsumer);
}

export function resetConfiguredBindingBuiltinsForTesting(): void {
  unregisterConfiguredBindingConsumer(acpConfiguredBindingConsumer.id);
}
