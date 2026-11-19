/** Shared fixtures for secrets runtime matrix tests. */
import { vi } from "vitest";
import { createRuntimeChannelSecretRegistry } from "./runtime-channel-secret.test-support.js";

/** Test-only bootstrap registry mock for Matrix secret surface tests. */
const matrixRegistry = createRuntimeChannelSecretRegistry("matrix", "Matrix");

// Keep the hoisted mock lazy while loading the real contract during module initialization.
// mock-isolation: Use the real channel secret contract without loading plugin bootstrap state.
vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: (id: string) => matrixRegistry.getBootstrapChannelPlugin(id),
  getBootstrapChannelSecrets: (id: string) => matrixRegistry.getBootstrapChannelSecrets(id),
}));
