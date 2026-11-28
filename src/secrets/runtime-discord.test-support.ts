/** Test bootstrap shim for Discord runtime-secret surface coverage. */
import { vi } from "vitest";
import { createRuntimeChannelSecretRegistry } from "./runtime-channel-secret.test-support.js";

/** Test-only bootstrap registry mock for Discord secret surface tests. */
const discordRegistry = createRuntimeChannelSecretRegistry("discord", "Discord");

// Keep the hoisted mock lazy while loading the real contract during module initialization.
// mock-isolation: Use the real channel secret contract without loading plugin bootstrap state.
vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: (id: string) => discordRegistry.getBootstrapChannelPlugin(id),
  getBootstrapChannelSecrets: (id: string) => discordRegistry.getBootstrapChannelSecrets(id),
}));
