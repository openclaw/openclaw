import { acpConfiguredBindingConsumer } from "./acp-configured-binding-consumer.js";
import { registerConfiguredBindingConsumer } from "./configured-binding-consumers.js";

/** Registers built-in configured-binding consumers such as ACP. */
export function ensureConfiguredBindingBuiltinsRegistered(): void {
  registerConfiguredBindingConsumer(acpConfiguredBindingConsumer);
}
