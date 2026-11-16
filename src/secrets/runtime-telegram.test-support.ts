/** Test bootstrap shim for Telegram runtime-secret surface coverage. */
import { vi } from "vitest";
import { createRuntimeChannelSecretRegistry } from "./runtime-channel-secret.test-support.js";

/** Test-only bootstrap registry mock for Telegram secret surface tests. */
const telegramRegistry = createRuntimeChannelSecretRegistry("telegram", "Telegram");

// Keep the hoisted mock lazy while loading the real contract during module initialization.
// mock-isolation: Use the real channel secret contract without loading plugin bootstrap state.
vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: (id: string) => telegramRegistry.getBootstrapChannelPlugin(id),
  getBootstrapChannelSecrets: (id: string) => telegramRegistry.getBootstrapChannelSecrets(id),
}));
