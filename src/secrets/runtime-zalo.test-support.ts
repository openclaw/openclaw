/** Test bootstrap shim for Zalo runtime-secret surface coverage. */
import { vi } from "vitest";
import { createRuntimeChannelSecretRegistry } from "./runtime-channel-secret.test-support.js";

/** Test-only bootstrap registry mock for Zalo secret surface tests. */
const zaloRegistry = createRuntimeChannelSecretRegistry("zalo", "Zalo");

// Keep the hoisted mock lazy while loading the real contract during module initialization.
// mock-isolation: Use the real channel secret contract without loading plugin bootstrap state.
vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: (id: string) => zaloRegistry.getBootstrapChannelPlugin(id),
  getBootstrapChannelSecrets: (id: string) => zaloRegistry.getBootstrapChannelSecrets(id),
}));
